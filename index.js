const express = require("express");
const { exec } = require("child_process");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const util = require("util");
const execPromise = util.promisify(exec);
const axios = require("axios");
const { spawn } = require("child_process");
const play = require('play-dl');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);

const app = express();
const port = 7700;

app.use(express.json());
app.use("/downloads", express.static("downloads"));

async function extractTikTokPhotoData(html) {
  try {
    const scriptMatch = html.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/
    );
    if (!scriptMatch) {
      throw new Error("Could not find TikTok data script");
    }

    const data = JSON.parse(scriptMatch[1]);
    const post =
      data["__DEFAULT_SCOPE__"]?.["webapp.video-detail"]?.["itemInfo"]?.[
        "itemStruct"
      ];

    if (!post) {
      throw new Error("Could not find post data");
    }

    if (!post.imagePost || !post.imagePost.images) {
      throw new Error("No images found in post");
    }

    const imageUrls = post.imagePost.images.map(
      (image) => image.imageURL.urlList[image.imageURL.urlList.length - 1]
    );

    if (!imageUrls.length) {
      throw new Error("No image URLs found");
    }

    return {
      urls: imageUrls,
      metadata: {
        title: post.desc || "TikTok Photo",
        uploader: post.author?.nickname,
        likeCount: post.stats?.diggCount,
        viewCount: post.stats?.playCount,
        commentCount: post.stats?.commentCount,
      },
    };
  } catch (error) {
    console.error("Error extracting TikTok photo data:", error);
    throw error;
  }
}

class TikTokPhotoDownloader {
  async downloadPhoto(url) {
    try {
      const fetch = (await import("node-fetch")).default;
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });

      const html = await response.text();
      const photoData = await extractTikTokPhotoData(html);

      const downloads = photoData.urls.map(async (imgUrl, index) => {
        const imgResponse = await fetch(imgUrl);
        const buffer = await imgResponse.buffer();
        const filename = `tiktok_photo_${index + 1}.jpg`;
        await fs.promises.writeFile(filename, buffer);
        return {
          filename,
          metadata: photoData.metadata,
        };
      });

      return Promise.all(downloads);
    } catch (error) {
      console.error("Error downloading TikTok photo:", error);
      throw error;
    }
  }
}

class Downloader {
  constructor() {
    this.galleryDlPath =
      process.platform === "win32"
        ? path.join(__dirname, "gallery-dl.exe")
        : "/usr/bin/gallery-dl";
    this.downloadsDir = path.join(__dirname, "downloads");
    if (!fs.existsSync(this.downloadsDir)) {
      fs.mkdirSync(this.downloadsDir);
    }
    this.startCleanupSchedule();
    this.cache = new Map();
    this.cacheTimeout = 3600000; 
  }

  startCleanupSchedule() {
    setInterval(() => {
      this.cleanupOldFiles();
    }, 1800000);
  }

  cleanupOldFiles() {
    const files = fs.readdirSync(this.downloadsDir);
    const now = Date.now();
    const maxAge = 12 * 60 * 60 * 1000;

    files.forEach((file) => {
      const filePath = path.join(this.downloadsDir, file);
      const stats = fs.statSync(filePath);
      const age = now - stats.mtimeMs;

      if (age > maxAge) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error(`Failed to delete ${file}:`, err);
        }
      }
    });
  }

  async resolveUrl(url) {
    try {
      const fetch = (await import("node-fetch")).default;
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html,application/json",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      });
      return response.url;
    } catch (error) {
      console.error("Error resolving URL:", error);
      throw error;
    }
  }

  async getPhotoUrls(url) {
    try {
      const fetch = (await import("node-fetch")).default;

      const finalUrl = await this.resolveUrl(url);
      console.log("Final URL:", finalUrl);

      const urlParts = new URL(finalUrl).pathname.split("/");
      const awemeId = urlParts[3];

      if (!awemeId) {
        throw new Error("Could not extract video ID from URL");
      }

      const apiUrl = `https://www.tiktok.com/@i/video/${awemeId}`;
      console.log("Fetching from API URL:", apiUrl);

      const response = await fetch(apiUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html,application/json",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      const html = await response.text();

      const scriptMatch = html.match(
        /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/
      );
      if (!scriptMatch) {
        throw new Error("Could not find TikTok data script");
      }

      const data = JSON.parse(scriptMatch[1]);
      const post =
        data["__DEFAULT_SCOPE__"]?.["webapp.video-detail"]?.["itemInfo"]?.[
          "itemStruct"
        ];

      if (!post) {
        throw new Error("Could not find post data");
      }

      if (!post.imagePost || !post.imagePost.images) {
        throw new Error("No images found in post");
      }

      return {
        urls: post.imagePost.images.map(
          (image) => image.imageURL.urlList[image.imageURL.urlList.length - 1]
        ),
        metadata: {
          title: post.desc || "TikTok Photo",
          uploader: post.author?.nickname,
          likeCount: post.stats?.diggCount,
          viewCount: post.stats?.playCount,
          commentCount: post.stats?.commentCount,
        },
      };
    } catch (error) {
      console.error("Error fetching photo URLs:", error);
      throw error;
    }
  }

  async downloadPhotos(url) {
    try {
      const photoData = await this.getPhotoUrls(url);
      const fetch = (await import("node-fetch")).default;

      const downloads = photoData.urls.map(async (imgUrl, index) => {
        const response = await fetch(imgUrl);
        const buffer = await response.buffer();
        const filename = `downloads/tiktok_photo_${index + 1}.jpg`;
        await fs.promises.writeFile(filename, buffer);
        return {
          filename,
          metadata: photoData.metadata,
        };
      });

      return Promise.all(downloads);
    } catch (error) {
      console.error("Download error:", error);
      throw error;
    }
  }

  extractPhotoData(item) {
    return {
      images: item.imagePost.images.map((img) => {
        const urls = img.imageURL?.urlList || [img.imageURL] || [img.url];
        return urls[0];
      }),
      info: {
        title: item.desc || "TikTok Photo",
        creator: item.author?.nickname || item.author?.uniqueId || "Unknown",
        creatorUrl: item.author?.uniqueId
          ? `https://www.tiktok.com/@${item.author.uniqueId}`
          : undefined,
        stats: {
          likes: item.stats?.diggCount || 0,
          shares: item.stats?.shareCount || 0,
          comments: item.stats?.commentCount || 0,
        },
        uploadDate: item.createTime
          ? new Date(item.createTime * 1000).toISOString()
          : undefined,
      },
    };
  }

  async getInfo(url) {
    const command = `yt-dlp "${url}" --dump-json`;
    const { stdout } = await execPromise(command);
    return JSON.parse(stdout);
  }

  async download(url, outputPath) {
    const options = [
      `--output "${outputPath}"`,
      '--format "best"',
      "--no-check-certificates",
      "--no-warnings",
      "--prefer-free-formats",
      "--extractor-args",
      '"tiktok:embed_api=true,api_hostname=api16-normal-c-useast1a.tiktokv.com,app_version=v26.1.3,manifest_app_version=26.1.3"',
    ];

    const command = `yt-dlp "${url}" ${options.join(" ")}`;
    console.log("Executing command:", command);

    const { stdout, stderr } = await execPromise(command);
    return { stdout, stderr };
  }

  async getInstagramUrl(url) {
    try {
      const fetch = (await import("node-fetch")).default;

      const finalUrl = await this.resolveUrl(url);
      console.log("Final Instagram URL:", finalUrl);

      let mediaId;
      const urlObj = new URL(finalUrl);
      const pathParts = urlObj.pathname.split("/").filter(Boolean);

      if (pathParts.includes("reel")) {
        const reelIndex = pathParts.indexOf("reel");
        mediaId = pathParts[reelIndex + 1];
      } else if (pathParts.includes("p")) {
        const postIndex = pathParts.indexOf("p");
        mediaId = pathParts[postIndex + 1];
      } else if (pathParts.includes("tv")) {
        const tvIndex = pathParts.indexOf("tv");
        mediaId = pathParts[tvIndex + 1];
      }

      mediaId = mediaId?.replace(/\?.*$/, "");

      if (!mediaId) {
        throw new Error("Could not extract Instagram media ID");
      }

      console.log("Extracted media ID:", mediaId);

      const webApiUrl = `https://www.instagram.com/p/${mediaId}/?__a=1&__d=dis`;
      console.log("Trying web API URL:", webApiUrl);

      const webResponse = await fetch(webApiUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html,application/json",
          "Accept-Language": "en-US,en;q=0.9",
          "X-IG-App-ID": "936619743392459",
          "X-Requested-With": "XMLHttpRequest",
        },
      });

      if (webResponse.ok) {
        const webData = await webResponse.json();
        const items = webData.items || webData.graphql?.shortcode_media;
        if (items) {
          const videoUrl = items.video_url || items[0]?.video_url;
          if (videoUrl) {
            return {
              url: videoUrl,
              metadata: {
                title: items.caption?.text || "Instagram Reel",
                uploader: items.user?.username,
                likeCount: items.like_count,
                viewCount: items.view_count,
                commentCount: items.comment_count,
                thumbnail: items.thumbnail_url || items.display_url,
                duration: items.video_duration,
                description: items.caption?.text,
                timestamp: items.taken_at_timestamp,
              },
            };
          }
        }
      }

      const mobileApiUrl = `https://i.instagram.com/api/v1/media/${mediaId}/info/`;
      console.log("Trying mobile API URL:", mobileApiUrl);

      const mobileResponse = await fetch(mobileApiUrl, {
        headers: {
          "User-Agent": "Instagram 219.0.0.12.117 Android",
          "X-IG-App-ID": "936619743392459",
          "X-IG-WWW-Claim": "0",
          "X-Instagram-AJAX": "1",
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          Origin: "https://www.instagram.com",
          Referer: "https://www.instagram.com/",
        },
      });

      if (!mobileResponse.ok) {
        throw new Error(
          `Instagram API error: ${mobileResponse.status} ${mobileResponse.statusText}`
        );
      }

      const data = await mobileResponse.json();

      if (!data.items?.[0]) {
        throw new Error("No media data found in response");
      }

      const item = data.items[0];
      let videoUrl;

      if (item.video_versions) {
        videoUrl = item.video_versions[0].url;
      } else if (item.carousel_media) {
        const videoMedia = item.carousel_media.find(
          (media) => media.video_versions
        );
        if (videoMedia) {
          videoUrl = videoMedia.video_versions[0].url;
        }
      }

      if (!videoUrl) {
        throw new Error("No video URL found in response");
      }

      return {
        url: videoUrl,
        metadata: {
          title: item.caption?.text || "Instagram Reel",
          uploader: item.user?.username,
          likeCount: item.like_count,
          viewCount: item.view_count,
          commentCount: item.comment_count,
          thumbnail: item.image_versions2?.candidates[0]?.url,
          duration: item.video_duration,
          description: item.caption?.text,
          timestamp: item.taken_at,
        },
      };
    } catch (error) {
      console.error("Error fetching Instagram URL:", error);
      throw error;
    }
  }

  async downloadInstagramReel(url) {
    try {
      const cachedResult = this.cache.get(url);
      if (cachedResult && Date.now() - cachedResult.timestamp < this.cacheTimeout) {
        console.log("Returning cached Instagram result");
        return cachedResult.data;
      }

      const filename = `downloads/instagram_${Date.now()}.mp4`;
      console.log("Trying yt-dlp for Instagram download:", url);

      let result;
      try {
        const downloadCommand = `yt-dlp "${url}" -o "${filename}" -f "best"`;
        await execPromise(downloadCommand);
        
        const infoCommand = `yt-dlp "${url}" --dump-json`;
        const { stdout: infoStdout } = await execPromise(infoCommand);
        const info = JSON.parse(infoStdout);
        
        result = {
          filename,
          metadata: {
            title: info.title || "Instagram Video",
            uploader: info.uploader,
            likeCount: info.like_count,
            viewCount: info.view_count,
            commentCount: info.comment_count,
            thumbnail: info.thumbnail,
            duration: info.duration,
            description: info.description,
            uploadDate: info.upload_date
          }
        };
      } catch (ytdlpError) {
        console.log('Standard yt-dlp failed, trying yt-dlp with cookies:', ytdlpError.message);
        
        const cookieCommand = `yt-dlp "${url}" -o "${filename}" -f "best" --cookies instagram_cookies.txt`;
        await execPromise(cookieCommand);
        
        if (!fs.existsSync(filename)) {
          throw new Error("No media file found after cookie attempt");
        }

        const infoCommand = `yt-dlp "${url}" --dump-json --cookies instagram_cookies.txt`;
        const { stdout: infoStdout } = await execPromise(infoCommand);
        const info = JSON.parse(infoStdout);

        result = {
          filename,
          metadata: {
            title: info.title || "Instagram Video",
            uploader: info.uploader,
            likeCount: info.like_count,
            viewCount: info.view_count,
            commentCount: info.comment_count,
            thumbnail: info.thumbnail,
            duration: info.duration,
            description: info.description,
            uploadDate: info.upload_date
          }
        };
      }

      this.cache.set(url, {
        timestamp: Date.now(),
        data: result
      });

      return result;
    } catch (error) {
      console.error("Download error:", error);
      throw error;
    }
  }

  async getYoutubeUrl(url) {
    try {
      const fetch = (await import("node-fetch")).default;

      const command = `yt-dlp "${url}" --dump-json`;
      console.log("Executing yt-dlp command:", command);

      const { stdout } = await execPromise(command);
      const info = JSON.parse(stdout);

      if (info.duration > 300) {
        throw new Error("Video exceeds 5 minutes limit");
      }

      const format = info.formats
        .filter(
          (f) =>
            f.ext === "mp4" &&
            f.vcodec !== "none" &&
            f.acodec !== "none" &&
            (f.height || 0) <= 1080
        )
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      if (!format) {
        throw new Error("No suitable video format found");
      }

      return {
        url: format.url,
        metadata: {
          title: info.title,
          uploader: info.uploader || info.channel,
          likeCount: info.like_count,
          viewCount: info.view_count,
          commentCount: info.comment_count,
          thumbnail: info.thumbnail,
          duration: info.duration,
          description: info.description,
          uploadDate: info.upload_date,
          quality: `${format.height}p`,
        },
      };
    } catch (error) {
      console.error("Error fetching YouTube URL:", error);
      throw error;
    }
  }

  async downloadYoutubeVideo(url) {
    try {
      const filename = `downloads/youtube_${Date.now()}.mp4`;
      const tempVideo = `${filename}.video.tmp`;
      const tempAudio = `${filename}.audio.tmp`;
      
      console.log("Downloading YouTube video:", url);

      const info = await play.video_info(url);
      
      const [video, audio] = await Promise.all([
        play.stream_from_info(info, { 
          quality: 137, 
          type: 'videoonly' 
        }),
        play.stream_from_info(info, { 
          quality: 140, 
          type: 'audioonly' 
        })
      ]);

      await Promise.all([
        pipeline(
          video.stream,
          fs.createWriteStream(tempVideo)
        ),
        pipeline(
          audio.stream,
          fs.createWriteStream(tempAudio)
        )
      ]);

      const ffmpeg = require('fluent-ffmpeg');
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(tempVideo)
          .input(tempAudio)
          .outputOptions([
            '-c:v copy',
            '-c:a aac',
            '-strict experimental'
          ])
          .on('end', resolve)
          .on('error', reject)
          .save(filename);
      });

      fs.unlinkSync(tempVideo);
      fs.unlinkSync(tempAudio);

      return {
        filename,
        metadata: {
          title: info.video_details.title,
          uploader: info.video_details.channel.name,
          uploadDate: info.video_details.uploadedAt,
          duration: info.video_details.durationInSec,
          viewCount: info.video_details.views,
          likeCount: info.video_details.likes,
          description: info.video_details.description,
          thumbnail: info.video_details.thumbnail.url,
          quality: '1080p'
        }
      };
    } catch (error) {
      try {
        if (fs.existsSync(tempVideo)) fs.unlinkSync(tempVideo);
        if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);
      } catch (cleanupError) {
        console.error("Cleanup error:", cleanupError);
      }
      
      console.error("YouTube download error:", error);
      throw error;
    }
  }

  async getSoundCloudUrl(url) {
    try {
      const command = `yt-dlp "${url}" --dump-json`;
      console.log("Executing yt-dlp command for SoundCloud:", command);

      const { stdout } = await execPromise(command);
      const info = JSON.parse(stdout);

      if (info.duration > 300) {
        throw new Error("Audio exceeds 5 minutes limit");
      }

      const format = info.formats
        .filter((f) => f.ext === "mp3" || f.acodec === "mp3")
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

      if (!format) {
        throw new Error("No suitable audio format found");
      }

      return {
        url: format.url,
        metadata: {
          title: info.title,
          uploader: info.uploader,
          likeCount: info.like_count,
          playCount: info.view_count,
          repostCount: info.repost_count,
          commentCount: info.comment_count,
          thumbnail: info.thumbnail,
          duration: info.duration,
          description: info.description,
          uploadDate: info.upload_date,
          genre: info.genre,
          quality: `${format.abr}kbps`,
        },
      };
    } catch (error) {
      console.error("Error fetching SoundCloud URL:", error);
      throw error;
    }
  }

  async downloadSoundCloudTrack(url) {
    try {
      const infoCommand = `yt-dlp "${url}" --dump-json`;
      console.log("Getting track info:", infoCommand);

      const { stdout } = await execPromise(infoCommand);
      const info = JSON.parse(stdout);

      if (info.duration > 300) {
        throw new Error("Audio exceeds 5 minutes limit");
      }

      const filename = `downloads/soundcloud_${Date.now()}.mp3`;
      const downloadCommand = `yt-dlp "${url}" -f bestaudio -x --audio-format mp3 --audio-quality 0 -o "${filename}"`;
      console.log("Executing download command:", downloadCommand);

      await execPromise(downloadCommand);

      return {
        filename,
        metadata: {
          title: info.title,
          uploader: info.uploader,
          likeCount: info.like_count,
          playCount: info.view_count,
          repostCount: info.repost_count,
          commentCount: info.comment_count,
          thumbnail: info.thumbnail,
          duration: info.duration,
          description: info.description,
          uploadDate: info.upload_date,
          genre: info.genre,
        },
      };
    } catch (error) {
      console.error("Download error:", error);
      throw error;
    }
  }

  async getTwitchClipUrl(url) {
    try {
      const command = `yt-dlp "${url}" --dump-json`;
      console.log("Executing yt-dlp command for Twitch clip:", command);

      const { stdout } = await execPromise(command);
      const info = JSON.parse(stdout);

      if (info.duration > 300) {
        throw new Error("Clip exceeds 5 minutes limit");
      }

      const format = info.formats
        .filter(
          (f) => f.ext === "mp4" && f.vcodec !== "none" && f.acodec !== "none"
        )
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      if (!format) {
        throw new Error("No suitable video format found");
      }

      return {
        url: format.url,
        metadata: {
          title: info.title,
          uploader: info.uploader,
          channel: info.channel,
          viewCount: info.view_count,
          thumbnail: info.thumbnail,
          duration: info.duration,
          description: info.description,
          uploadDate: info.upload_date,
          quality: `${format.height}p`,
          game: info.game || "Unknown Game",
        },
      };
    } catch (error) {
      console.error("Error fetching Twitch clip URL:", error);
      throw error;
    }
  }

  async downloadTwitchClip(url) {
    try {
      const videoData = await this.getTwitchClipUrl(url);
      const fetch = (await import("node-fetch")).default;

      console.log("Downloading from URL:", videoData.url);

      const response = await fetch(videoData.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "*/*",
          Origin: "https://www.twitch.tv",
          Referer: "https://www.twitch.tv/",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Download failed: ${response.status} ${response.statusText}`
        );
      }

      const buffer = await response.buffer();
      const filename = `downloads/twitch_clip_${Date.now()}.mp4`;
      await fs.promises.writeFile(filename, buffer);

      console.log("Successfully downloaded to:", filename);

      return {
        filename,
        metadata: videoData.metadata,
      };
    } catch (error) {
      console.error("Download error:", error);
      throw error;
    }
  }

  async getRedditUrl(url) {
    try {
      const command = `yt-dlp "${url}" --dump-json`;
      console.log("Executing yt-dlp command for Reddit:", command);

      try {
        const { stdout } = await execPromise(command);
        const info = JSON.parse(stdout);
      } catch (error) {
        console.log("yt-dlp failed, checking if image post...");

        const fetch = (await import("node-fetch")).default;
        const response = await fetch(`${url}.json`, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          redirect: "follow",
        });

        if (!response.ok) {
          throw new Error(
            `Reddit API error: ${response.status} ${response.statusText}`
          );
        }

        const data = await response.json();
        console.log("Reddit API response:", JSON.stringify(data, null, 2));

        const post = data[0]?.data?.children[0]?.data;
        if (!post) {
          throw new Error("Could not fetch post data");
        }

        if (post.is_video === false) {
          let imageUrl = post.url;

          if (post.domain === "i.redd.it" || imageUrl.includes("i.redd.it")) {
            imageUrl = post.url;
          } else if (post.preview?.images?.[0]?.source?.url) {
            imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, "&");
          } else if (post.is_gallery && post.gallery_data) {
            const firstImageId = post.gallery_data.items[0].media_id;
            imageUrl = post.media_metadata[firstImageId].s.u.replace(
              /&amp;/g,
              "&"
            );
          }

          if (
            !imageUrl ||
            (!imageUrl.endsWith(".jpg") &&
              !imageUrl.endsWith(".jpeg") &&
              !imageUrl.endsWith(".png"))
          ) {
            throw new Error("No valid image URL found");
          }

          return {
            isImage: true,
            url: imageUrl,
            metadata: {
              title: post.title,
              uploader: post.author,
              subreddit: post.subreddit,
              upvotes: post.ups,
              upvoteRatio: post.upvote_ratio,
              viewCount: post.view_count,
              thumbnail: post.thumbnail,
              description: post.selftext,
              uploadDate: new Date(post.created_utc * 1000).toISOString(),
              isNsfw: post.over_18,
            },
          };
        }

        throw new Error("Not a supported Reddit media post");
      }
    } catch (error) {
      console.error("Error fetching Reddit URL:", error);
      throw error;
    }
  }

  async downloadRedditMedia(url) {
    try {
      const galleryDlPath =
        process.platform === "win32"
          ? path.join(__dirname, "gallery-dl.exe")
          : "/usr/bin/gallery-dl";
      const imageCommand = `"${galleryDlPath}" "${url}" -D downloads -f "reddit_{id}.{extension}" --verbose --write-metadata --write-info-json --write-pages`;
      console.log("Trying gallery-dl command:", imageCommand);

      try {
        const { stdout } = await execPromise(imageCommand);
        console.log("Gallery-dl output:", stdout);

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const files = await fs.promises.readdir("./downloads");
        console.log("Files in downloads directory:", files);

        const postId = url.split("/comments/")[1]?.split("/")[0];
        console.log("Looking for files with post ID:", postId);

        const downloadedFile = files.find(
          (f) =>
            f.includes(postId) &&
            (f.endsWith(".jpg") ||
              f.endsWith(".png") ||
              f.endsWith(".mp4") ||
              f.endsWith(".gif"))
        );

        if (!downloadedFile) {
          throw new Error("No media file found in post");
        }

        console.log("Found downloaded file:", downloadedFile);

        const metadataFile = files.find(
          (f) => f.includes(postId) && f.endsWith(".json")
        );
        let postMetadata = {};
        if (metadataFile) {
          try {
            const metadataContent = await fs.promises.readFile(
              path.join("./downloads", metadataFile),
              "utf8"
            );
            postMetadata = JSON.parse(metadataContent);
            console.log("Post metadata:", postMetadata);
          } catch (e) {
            console.error("Error reading metadata:", e);
          }
        }

        const isImage = !downloadedFile.endsWith(".mp4");
        const metadata = {
          title: postMetadata.title || "Reddit Post",
          uploader: postMetadata.author || url.split("/r/")[1]?.split("/")[0],
          subreddit:
            postMetadata.subreddit || url.split("/r/")[1]?.split("/")[0],
          upvotes: postMetadata.score,
          upvoteRatio: postMetadata.upvote_ratio,
          viewCount: postMetadata.view_count,
          thumbnail: postMetadata.thumbnail,
          description: postMetadata.selftext,
          uploadDate: postMetadata.timestamp
            ? new Date(postMetadata.timestamp * 1000)
                .toISOString()
                .split("T")[0]
            : new Date().toISOString().split("T")[0],
          isNsfw: postMetadata.over_18,
          quality: isImage ? "original" : "unknown",
        };

        return {
          filename: `downloads/${downloadedFile}`,
          isImage,
          metadata,
        };
      } catch (error) {
        console.error("Gallery-dl error:", error);
        console.error("Gallery-dl stderr:", error.stderr);
        throw new Error(`Gallery-dl failed: ${error.message}`);
      }
    } catch (error) {
      console.error("Download error:", error);
      throw error;
    }
  }

  async getTwitterUrl(url) {
    try {
      const command = `yt-dlp "${url}" --dump-json`;
      console.log("Executing yt-dlp command for Twitter:", command);

      try {
        const { stdout } = await execPromise(command);
        const info = JSON.parse(stdout);
      } catch (error) {
        console.log("yt-dlp failed, checking if image post...");

        const fetch = (await import("node-fetch")).default;
        const response = await fetch(
          `https://api.twitter.com/2/tweets/${url
            .split("/")
            .pop()}?expansions=attachments.media_keys&media.fields=url,preview_image_url`,
          {
            headers: {
              Authorization:
                "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
          }
        );

        if (!response.ok) {
          throw new Error(
            `Twitter API error: ${response.status} ${response.statusText}`
          );
        }

        const data = await response.json();
        const imageUrl =
          data.includes?.media?.[0]?.url ||
          data.includes?.media?.[0]?.preview_image_url;

        if (!imageUrl) {
          throw new Error("No image found in tweet");
        }

        return {
          isImage: true,
          url: imageUrl,
          metadata: {
            title: data.data?.text,
            uploader: data.includes?.users?.[0]?.name,
            username: data.includes?.users?.[0]?.username,
            likeCount: data.data?.public_metrics?.like_count,
            retweetCount: data.data?.public_metrics?.retweet_count,
            replyCount: data.data?.public_metrics?.reply_count,
            viewCount: data.data?.public_metrics?.impression_count,
            uploadDate: data.data?.created_at,
          },
        };
      }
    } catch (error) {
      console.error("Error fetching Twitter URL:", error);
      throw error;
    }
  }

  async downloadTwitterMedia(url) {
    try {
      const galleryDlPath =
        process.platform === "win32"
          ? path.join(__dirname, "gallery-dl.exe")
          : "/usr/bin/gallery-dl";
      const imageCommand = `"${galleryDlPath}" "${url}" -D downloads -f "twitter_{tweet_id}.{extension}" --verbose --write-metadata --write-info-json --write-pages`;
      console.log("Trying gallery-dl command:", imageCommand);

      try {
        const { stdout } = await execPromise(imageCommand);
        console.log("Gallery-dl output:", stdout);

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const files = await fs.promises.readdir("./downloads");
        console.log("Files in downloads directory:", files);

        const tweetId = url.split("/").pop().split("?")[0];
        console.log("Looking for files with tweet ID:", tweetId);

        const tweetCommand = `"${galleryDlPath}" "${url}" --write-pages --dump-json`;
        const { stdout: tweetJson } = await execPromise(tweetCommand);
        const tweetData = JSON.parse(tweetJson);
        const tweetText =
          tweetData?.content || "شغلات انصدمت انها في شي ان !!! شاركوا تحت 👇🏼";

        const downloadedFile = files.find(
          (f) =>
            f.includes(tweetId) &&
            (f.endsWith(".jpg") || f.endsWith(".png") || f.endsWith(".mp4"))
        );

        if (!downloadedFile) {
          throw new Error("No media file found in tweet");
        }

        console.log("Found downloaded file:", downloadedFile);

        const metadataFile = files.find(
          (f) => f.includes(tweetId) && f.endsWith(".json")
        );
        let tweetMetadata = {};
        if (metadataFile) {
          try {
            const metadataContent = await fs.promises.readFile(
              path.join("./downloads", metadataFile),
              "utf8"
            );
            tweetMetadata = JSON.parse(metadataContent);
          } catch (e) {
            console.error("Error reading metadata:", e);
          }
        }

        const isImage = !downloadedFile.endsWith(".mp4");
        const metadata = {
          title: tweetText,
          uploader: tweetMetadata.author?.name || url.split("/")[3],
          username: tweetMetadata.author?.username || url.split("/")[3],
          uploadDate:
            tweetMetadata.date ||
            new Date().toISOString().split("T")[0].replace(/-/g, ""),
          quality: isImage ? "original" : "unknown",
          likes: tweetMetadata.like_count,
          retweets: tweetMetadata.retweet_count,
          replies: tweetMetadata.reply_count,
          text: tweetText,
        };

        return {
          filename: `downloads/${downloadedFile}`,
          isImage,
          metadata,
        };
      } catch (error) {
        console.error("Gallery-dl error:", error);
        console.error("Gallery-dl stderr:", error.stderr);
        throw new Error(`Gallery-dl failed: ${error.message}`);
      }
    } catch (error) {
      console.error("Download error:", error);
      throw error;
    }
  }

  async downloadMedalMedia(url) {
    try {
      const filename = `downloads/medal_${Date.now()}.mp4`;
      console.log("Trying yt-dlp command for Medal:", url);

      try {
        const infoCommand = `yt-dlp "${url}" --dump-json`;
        const { stdout: infoStdout } = await execPromise(infoCommand);
        const info = JSON.parse(infoStdout);

        const downloadCommand = `yt-dlp "${url}" -o "${filename}" -f "best"`;
        await execPromise(downloadCommand);

        if (!fs.existsSync(filename)) {
          throw new Error("No media file found in Medal clip");
        }

        const metadata = {
          title: info.title || "Medal Clip",
          uploader: info.uploader || "Unknown",
          uploadDate:
            info.upload_date || new Date().toISOString().split("T")[0],
          quality: info.format_note || "unknown",
          game: info.game,
          views: info.view_count,
          likes: info.like_count,
          duration: info.duration,
          thumbnail: info.thumbnail,
        };

        return {
          filename,
          isImage: false,
          metadata,
        };
      } catch (error) {
        console.error("yt-dlp error:", error);
        console.error("yt-dlp stderr:", error.stderr);
        throw new Error(`Medal download failed: ${error.message}`);
      }
    } catch (error) {
      console.error("Medal download error:", error);
      throw error;
    }
  }

  async downloadStreamableMedia(url) {
    try {
      const filename = `downloads/streamable_${Date.now()}.mp4`;
      console.log("Trying yt-dlp command for Streamable:", url);

      try {
        const infoCommand = `yt-dlp "${url}" --dump-json`;
        const { stdout: infoStdout } = await execPromise(infoCommand);
        const info = JSON.parse(infoStdout);

        const downloadCommand = `yt-dlp "${url}" -o "${filename}" -f "best"`;
        await execPromise(downloadCommand);

        if (!fs.existsSync(filename)) {
          throw new Error("No media file found in Streamable clip");
        }

        const metadata = {
          title: info.title || "Streamable Video",
          uploadDate:
            info.upload_date || new Date().toISOString().split("T")[0],
          quality: info.format_note || "unknown",
          views: info.view_count,
          duration: info.duration,
          thumbnail: info.thumbnail,
          description: info.description,
        };

        return {
          filename,
          isImage: false,
          metadata,
        };
      } catch (error) {
        console.error("yt-dlp error:", error);
        console.error("yt-dlp stderr:", error.stderr);
        throw new Error(`Streamable download failed: ${error.message}`);
      }
    } catch (error) {
      console.error("Streamable download error:", error);
      throw error;
    }
  }

  async downloadVimeoMedia(url) {
    try {
      const filename = `downloads/vimeo_${Date.now()}.mp4`;
      console.log("Trying yt-dlp command for Vimeo:", url);

      try {
        const infoCommand = `yt-dlp "${url}" --dump-json`;
        const { stdout: infoStdout } = await execPromise(infoCommand);
        const info = JSON.parse(infoStdout);

        const downloadCommand = `yt-dlp "${url}" -o "${filename}" -f "bestvideo+bestaudio/best"`;
        await execPromise(downloadCommand);

        if (!fs.existsSync(filename)) {
          throw new Error("No media file found in Vimeo video");
        }

        const metadata = {
          title: info.title || "Vimeo Video",
          uploader: info.uploader || "Unknown",
          uploadDate:
            info.upload_date || new Date().toISOString().split("T")[0],
          quality: info.format_note || "unknown",
          views: info.view_count,
          likes: info.like_count,
          description: info.description,
          duration: info.duration,
          thumbnail: info.thumbnail,
          tags: info.tags,
          category: info.categories?.[0],
        };

        return {
          filename,
          isImage: false,
          metadata,
        };
      } catch (error) {
        console.error("yt-dlp error:", error);
        console.error("yt-dlp stderr:", error.stderr);
        throw new Error(`Vimeo download failed: ${error.message}`);
      }
    } catch (error) {
      console.error("Vimeo download error:", error);
      throw error;
    }
  }

  async downloadKickMedia(url) {
    try {
      const filename = `downloads/kick_${Date.now()}.mp4`;
      console.log("Trying yt-dlp command for Kick:", url);

      try {
        const infoCommand = `yt-dlp "${url}" --dump-json`;
        const { stdout: infoStdout } = await execPromise(infoCommand);
        const info = JSON.parse(infoStdout);

        const downloadCommand = `yt-dlp "${url}" -o "${filename}" -f "best"`;
        await execPromise(downloadCommand);

        if (!fs.existsSync(filename)) {
          throw new Error("No media file found in Kick video");
        }

        const metadata = {
          title: info.title || "Kick Video",
          uploader: info.uploader || url.split("/")[3],
          uploadDate:
            info.upload_date || new Date().toISOString().split("T")[0],
          quality: info.format_note || "unknown",
          views: info.view_count,
          duration: info.duration,
          thumbnail: info.thumbnail,
          description: info.description,
        };

        return {
          filename,
          isImage: false,
          metadata,
        };
      } catch (error) {
        console.error("yt-dlp error:", error);
        console.error("yt-dlp stderr:", error.stderr);
        throw new Error(`Kick download failed: ${error.message}`);
      }
    } catch (error) {
      console.error("Kick download error:", error);
      throw error;
    }
  }

  async downloadFacebookMedia(url) {
    try {
      const filename = `downloads/facebook_${Date.now()}.mp4`;
      console.log("Trying yt-dlp command for Facebook:", url);

      try {
        const infoCommand = `yt-dlp "${url}" --dump-json`;
        const { stdout: infoStdout } = await execPromise(infoCommand);
        const info = JSON.parse(infoStdout);

        const downloadCommand = `yt-dlp "${url}" -o "${filename}" -f "best"`;
        await execPromise(downloadCommand);

        if (!fs.existsSync(filename)) {
          throw new Error("No media file found in Facebook post");
        }

        const metadata = {
          title: info.title || "Facebook Video",
          uploader: info.uploader || info.channel || "Unknown",
          uploadDate:
            info.upload_date || new Date().toISOString().split("T")[0],
          quality: info.format_note || "unknown",
          duration: info.duration,
          thumbnail: info.thumbnail,
          description: info.description,
          stats: {
            views: info.view_count,
            likes: info.like_count,
            comments: info.comment_count,
            shares: info.repost_count,
          },
        };

        return {
          filename,
          isImage: false,
          metadata,
        };
      } catch (error) {
        console.error("yt-dlp error:", error);
        console.error("yt-dlp stderr:", error.stderr);
        throw new Error(`Facebook download failed: ${error.message}`);
      }
    } catch (error) {
      console.error("Facebook download error:", error);
      throw error;
    }
  }

  extractCdnUrls(html) {
    const urlPattern = /https:\/\/[^"]*\.(?:mp4|sc-cdn\.net[^"]*)/g;
    const matches = html.match(urlPattern) || [];
    return [...new Set(matches)];
  }

  async downloadSnapchatMedia(url) {
    try {
      console.log("Detected Snapchat URL, fetching media...");

      if (url.includes("spotlight")) {
        console.log("Detected Snapchat Spotlight URL");
        const response = await axios.get(url);
        const pageContent = response.data;
        console.log("Page content length:", pageContent.length);

        const cdnUrls = this.extractCdnUrls(pageContent);
        console.log("Found CDN URLs:", cdnUrls);

        for (const cdnUrl of cdnUrls) {
          try {
            console.log("Trying CDN URL:", cdnUrl);
            const videoResponse = await axios.get(cdnUrl, {
              responseType: "arraybuffer",
            });

            const contentType = videoResponse.headers["content-type"];
            if (contentType && contentType.includes("video")) {
              console.log("Found valid video URL:", cdnUrl);

              const videoBuffer = Buffer.from(videoResponse.data);

              const filename = `snapchat_${Date.now()}.mp4`;
              const filepath = path.join(this.downloadsDir, filename);
              await fs.promises.writeFile(filepath, videoBuffer);
              return filepath;
            }
          } catch (err) {
            console.log("Failed to fetch CDN URL:", err.message);
            continue;
          }
        }

        if (cdnUrls.length > 0) {
          console.log("Found CDN URLs but none contained valid video content");
        }
        throw new Error("Could not find valid video content in Spotlight page");
      } else {
        let username;
        if (url.includes("snapchat.com/add/")) {
          username = url.split("/add/")[1];
        } else if (!url.includes("snapchat.com")) {
          username = url;
        } else {
          username = url.split("/").pop();
        }
        username = username.split("?")[0].trim();

        const fetch = (await import("node-fetch")).default;
        const response = await fetch(
          `https://story.snapchat.com/s/${username}`,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
          }
        );

        const html = await response.text();

        const videoUrlMatch = html.match(/https:\/\/[^"]*\.mp4/);
        if (!videoUrlMatch) {
          throw new Error("Could not find story video URL");
        }

        const videoUrl = videoUrlMatch[0];
        console.log("Found video URL:", videoUrl);

        const videoResponse = await fetch(videoUrl);
        const filename = `downloads/snapchat_${username}_${Date.now()}.mp4`;
        await fs.promises.writeFile(filename, await videoResponse.buffer());

        const metadata = {
          title: "Snapchat Story",
          uploader: username,
          uploadDate: new Date().toISOString().split("T")[0],
          quality: "original",
          type: "story",
        };

        return {
          filename,
          isImage: false,
          metadata,
        };
      }
    } catch (error) {
      console.log("Snapchat download error:", error);
      console.log(
        "Please check if the Spotlight URL is accessible in your browser"
      );
      console.log("You might need to be logged in to access this content");
      throw error;
    }
  }

  async downloadInstagramMedia(url) {
    const outputDir = path.join(__dirname, './downloads');
    const baseFileName = uuidv4();
    
    const metadataProcess = await new Promise((resolve, reject) => {
        const process = spawn(this.galleryDlPath, [
            url,
            '--dump-json'
        ]);

        let jsonData = '';
        process.stdout.on('data', data => jsonData += data);
        process.on('close', () => {
            try {
                const metadata = JSON.parse(jsonData);
                resolve(metadata);
            } catch (e) {
                resolve(null);
            }
        });
    });

    const { stdout, stderr } = await new Promise((resolve, reject) => {
        const process = spawn(this.galleryDlPath, [
            url,
            '--range', '1-',
            '--filename', path.join(outputDir, `${baseFileName}_{num}.{extension}`),
            '--no-mtime'
        ]);

        let stdoutData = '';
        let stderrData = '';
        process.stdout.on('data', data => stdoutData += data);
        process.stderr.on('data', data => stderrData += data);
        process.on('close', code => {
            if (code !== 0) {
                reject(new Error(`gallery-dl exited with code ${code}: ${stderrData}`));
                return;
            }
            resolve({ stdout: stdoutData, stderr: stderrData });
        });
    });

    const files = fs.readdirSync(outputDir)
        .filter(file => file.startsWith(baseFileName))
        .map(file => path.join(outputDir, file));

    if (files.length === 0) {
        throw new Error('Failed to download Instagram media');
    }

    const mediaFiles = files.map(file => ({
        filename: file,
        type: path.extname(file).toLowerCase() === '.mp4' ? 'video' : 'image',
        metadata: metadataProcess ? {
            title: metadataProcess.title || metadataProcess.description,
            uploader: metadataProcess.uploader,
            timestamp: metadataProcess.timestamp,
            likes: metadataProcess.like_count,
            comments: metadataProcess.comment_count,
            views: metadataProcess.view_count
        } : null
    }));

    return mediaFiles.length === 1 ? mediaFiles[0] : mediaFiles;
  }
}

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || authHeader !== "r2aq4t9ma69OiC51t") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

app.post("/download", authMiddleware, async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  try {
    const downloader = new Downloader();
    const resolvedUrl = await downloader.resolveUrl(url);

    if (resolvedUrl.includes("/photo/")) {
      console.log("Detected photo post, downloading images...");
      const photoData = await downloader.downloadPhotos(resolvedUrl);

      const photoUrls = photoData.map(photo => {
        return {
          url: `${req.protocol}://${req.get("host")}/${photo.filename}`,
          metadata: photo.metadata
        };
      });

      return res.json({
        success: true,
        type: "photo",
        photos: photoUrls,
        metadata: photoData[0].metadata
      });
    }

    if (resolvedUrl.includes("twitter.com") || resolvedUrl.includes("x.com")) {
      console.log("Detected Twitter URL, fetching media...");
      const mediaData = await downloader.downloadTwitterMedia(resolvedUrl);

      const mediaUrl = `${req.protocol}://${req.get(
        "host"
      )}/downloads/${path.basename(mediaData.filename)}`;

      return res.json({
        success: true,
        type: mediaData.isImage ? "twitter_image" : "twitter_video",
        url: mediaUrl,
        metadata: {
          title: mediaData.metadata.title,
          uploader: mediaData.metadata.uploader,
          username: mediaData.metadata.username,
          stats: {
            likes: mediaData.metadata.likeCount,
            retweets: mediaData.metadata.retweets,
            replies: mediaData.metadata.replies,
            views: mediaData.metadata.viewCount,
          },
          thumbnail: mediaData.metadata.thumbnail,
          uploadDate: mediaData.metadata.uploadDate,
          quality: mediaData.metadata.quality,
        },
        fileInfo: {
          fileName: path.basename(mediaData.filename),
          fileSize: fs.statSync(mediaData.filename).size,
          outputPath: mediaData.filename,
          format: mediaData.isImage
            ? path.extname(mediaData.filename).slice(1)
            : "mp4",
        },
      });
    }

    if (resolvedUrl.includes("reddit.com") || resolvedUrl.includes("redd.it")) {
      console.log("Detected Reddit URL, fetching media...");
      const mediaData = await downloader.downloadRedditMedia(resolvedUrl);

      const mediaUrl = `${req.protocol}://${req.get(
        "host"
      )}/downloads/${path.basename(mediaData.filename)}`;

      return res.json({
        success: true,
        type: mediaData.isImage ? "reddit_image" : "reddit_video",
        url: mediaUrl,
        metadata: {
          title: mediaData.metadata.title,
          uploader: mediaData.metadata.uploader,
          subreddit: mediaData.metadata.subreddit,
          stats: {
            upvotes: mediaData.metadata.upvotes,
            upvoteRatio: mediaData.metadata.upvoteRatio,
            views: mediaData.metadata.viewCount,
          },
          thumbnail: mediaData.metadata.thumbnail,
          description: mediaData.metadata.description,
          uploadDate: mediaData.metadata.uploadDate,
          isNsfw: mediaData.metadata.isNsfw,
          quality: mediaData.metadata.quality,
        },
        fileInfo: {
          fileName: path.basename(mediaData.filename),
          fileSize: fs.statSync(mediaData.filename).size,
          outputPath: mediaData.filename,
          format: mediaData.isImage
            ? path.extname(mediaData.filename).slice(1)
            : "mp4",
        },
      });
    }

    if (
      resolvedUrl.includes("twitch.tv") &&
      (resolvedUrl.includes("/clip/") ||
        resolvedUrl.includes("clips.twitch.tv"))
    ) {
      console.log("Detected Twitch clip URL, fetching video...");
      const clipData = await downloader.downloadTwitchClip(resolvedUrl);

      const videoUrl = `${req.protocol}://${req.get(
        "host"
      )}/downloads/${path.basename(clipData.filename)}`;

      return res.json({
        success: true,
        type: "twitch_clip",
        url: videoUrl,
        metadata: {
          title: clipData.metadata.title,
          uploader: clipData.metadata.uploader,
          channel: clipData.metadata.channel,
          stats: {
            views: clipData.metadata.viewCount,
          },
          thumbnail: clipData.metadata.thumbnail,
          duration: clipData.metadata.duration,
          description: clipData.metadata.description,
          uploadDate: clipData.metadata.uploadDate,
          quality: clipData.metadata.quality,
          game: clipData.metadata.game,
        },
        fileInfo: {
          fileName: path.basename(clipData.filename),
          fileSize: fs.statSync(clipData.filename).size,
          outputPath: clipData.filename,
        },
      });
    }

    if (resolvedUrl.includes("soundcloud.com")) {
      console.log("Detected SoundCloud URL, fetching audio...");
      const audioData = await downloader.downloadSoundCloudTrack(resolvedUrl);

      const audioUrl = `${req.protocol}://${req.get(
        "host"
      )}/downloads/${path.basename(audioData.filename)}`;

      return res.json({
        success: true,
        type: "soundcloud",
        url: audioUrl,
        metadata: {
          title: audioData.metadata.title,
          uploader: audioData.metadata.uploader,
          stats: {
            likes: audioData.metadata.likeCount,
            plays: audioData.metadata.playCount,
            reposts: audioData.metadata.repostCount,
            comments: audioData.metadata.commentCount,
          },
          thumbnail: audioData.metadata.thumbnail,
          duration: audioData.metadata.duration,
          description: audioData.metadata.description,
          uploadDate: audioData.metadata.uploadDate,
          genre: audioData.metadata.genre,
          quality: audioData.metadata.quality,
        },
        fileInfo: {
          fileName: path.basename(audioData.filename),
          fileSize: fs.statSync(audioData.filename).size,
          outputPath: audioData.filename,
          format: "mp3",
        },
      });
    }

    if (
      resolvedUrl.includes("youtube.com") ||
      resolvedUrl.includes("youtu.be")
    ) {
      console.log("Detected YouTube URL, fetching video...");
      const videoData = await downloader.downloadYoutubeVideo(resolvedUrl);

      const videoUrl = `${req.protocol}://${req.get(
        "host"
      )}/downloads/${path.basename(videoData.filename)}`;

      return res.json({
        success: true,
        type: "youtube",
        url: videoUrl,
        title: videoData.metadata.title,
        description: videoData.metadata.description,
        creator: videoData.metadata.uploader,
        creatorUrl: videoData.metadata.uploader_url,
        stats: {
          likes: videoData.metadata.likeCount,
          shares: videoData.metadata.repost_count,
          comments: videoData.metadata.comment_count,
          views: videoData.metadata.view_count,
        },
        thumbnail: videoData.metadata.thumbnail,
        duration: videoData.metadata.duration,
        uploadDate: videoData.metadata.upload_date,
        fileInfo: {
          fileName: path.basename(videoData.filename),
          fileSize: fs.statSync(videoData.filename).size,
          outputPath: videoData.filename,
        },
      });
    }

    if (resolvedUrl.includes("instagram.com")) {
      console.log("Detected Instagram URL, fetching video...");
      const reelData = await downloader.downloadInstagramReel(resolvedUrl);

      const videoUrl = `${req.protocol}://${req.get(
        "host"
      )}/downloads/${path.basename(reelData.filename)}`;

      return res.json({
        success: true,
        type: "instagram_reel",
        url: videoUrl,
        metadata: {
          title: reelData.metadata.title,
          uploader: reelData.metadata.uploader,
          stats: {
            likes: reelData.metadata.likeCount,
            views: reelData.metadata.viewCount,
            comments: reelData.metadata.commentCount,
          },
          thumbnail: reelData.metadata.thumbnail,
          duration: reelData.metadata.duration,
          description: reelData.metadata.description,
        },
        fileInfo: {
          fileName: path.basename(reelData.filename),
          fileSize: fs.statSync(reelData.filename).size,
          outputPath: reelData.filename,
        },
      });
    }

    if (resolvedUrl.includes("medal.tv")) {
      console.log("Detected Medal URL, fetching media...");
      const mediaData = await downloader.downloadMedalMedia(resolvedUrl);

      const mediaUrl = `${req.protocol}://${req.get(
        "host"
      )}/downloads/${path.basename(mediaData.filename)}`;

      return res.json({
        success: true,
        type: "medal_clip",
        url: mediaUrl,
        metadata: {
          title: mediaData.metadata.title,
          uploader: mediaData.metadata.uploader,
          game: mediaData.metadata.game,
          stats: {
            views: mediaData.metadata.views,
            likes: mediaData.metadata.likes,
          },
          uploadDate: mediaData.metadata.uploadDate,
          quality: mediaData.metadata.quality,
        },
        fileInfo: {
          fileName: path.basename(mediaData.filename),
          fileSize: fs.statSync(mediaData.filename).size,
          outputPath: mediaData.filename,
        },
      });
    }

    if (resolvedUrl.includes("streamable.com")) {
      console.log("Detected Streamable URL, fetching media...");
      const mediaData = await downloader.downloadStreamableMedia(resolvedUrl);

      const mediaUrl = `${req.protocol}://${req.get(
        "host"
      )}/downloads/${path.basename(mediaData.filename)}`;

      return res.json({
        success: true,
        type: "streamable",
        url: mediaUrl,
        metadata: {
          title: mediaData.metadata.title,
          stats: {
            views: mediaData.metadata.views,
          },
          uploadDate: mediaData.metadata.uploadDate,
          quality: mediaData.metadata.quality,
        },
        fileInfo: {
          fileName: path.basename(mediaData.filename),
          fileSize: fs.statSync(mediaData.filename).size,
          outputPath: mediaData.filename,
        },
      });
    }

    if (resolvedUrl.includes("vimeo.com")) {
      console.log("Detected Vimeo URL, fetching media...");
      const mediaData = await downloader.downloadVimeoMedia(resolvedUrl);

      const mediaUrl = `${req.protocol}://${req.get(
        "host"
      )}/downloads/${path.basename(mediaData.filename)}`;

      return res.json({
        success: true,
        type: "vimeo",
        url: mediaUrl,
        metadata: {
          title: mediaData.metadata.title,
          uploader: mediaData.metadata.uploader,
          stats: {
            views: mediaData.metadata.views,
            likes: mediaData.metadata.likes,
          },
          description: mediaData.metadata.description,
          uploadDate: mediaData.metadata.uploadDate,
          quality: mediaData.metadata.quality,
        },
        fileInfo: {
          fileName: path.basename(mediaData.filename),
          fileSize: fs.statSync(mediaData.filename).size,
          outputPath: mediaData.filename,
        },
      });
    }

    if (resolvedUrl.includes("kick.com")) {
      console.log("Detected Kick URL, fetching media...");
      const mediaData = await downloader.downloadKickMedia(resolvedUrl);

      const mediaUrl = `${req.protocol}://${req.get(
        "host"
      )}/downloads/${path.basename(mediaData.filename)}`;

      return res.json({
        success: true,
        type: "kick_clip",
        url: mediaUrl,
        metadata: {
          title: mediaData.metadata.title,
          uploader: mediaData.metadata.uploader,
          category: mediaData.metadata.category,
          stats: {
            views: mediaData.metadata.views,
          },
          uploadDate: mediaData.metadata.uploadDate,
          quality: mediaData.metadata.quality,
        },
        fileInfo: {
          fileName: path.basename(mediaData.filename),
          fileSize: fs.statSync(mediaData.filename).size,
          outputPath: mediaData.filename,
        },
      });
    }

    if (
      resolvedUrl.includes("facebook.com") ||
      resolvedUrl.includes("fb.watch")
    ) {
      console.log("Detected Facebook URL, fetching media...");
      const mediaData = await downloader.downloadFacebookMedia(resolvedUrl);

      const mediaUrl = `${req.protocol}://${req.get(
        "host"
      )}/downloads/${path.basename(mediaData.filename)}`;

      return res.json({
        success: true,
        type: "facebook",
        url: mediaUrl,
        metadata: {
          title: mediaData.metadata.title,
          uploader: mediaData.metadata.uploader,
          stats: {
            views: mediaData.metadata.stats.views,
            likes: mediaData.metadata.stats.likes,
            comments: mediaData.metadata.stats.comments,
            shares: mediaData.metadata.stats.shares,
          },
          description: mediaData.metadata.description,
          uploadDate: mediaData.metadata.uploadDate,
          quality: mediaData.metadata.quality,
          duration: mediaData.metadata.duration,
        },
        fileInfo: {
          fileName: path.basename(mediaData.filename),
          fileSize: fs.statSync(mediaData.filename).size,
          outputPath: mediaData.filename,
        },
      });
    }

    if (resolvedUrl.includes("snapchat.com")) {
      console.log("Detected Snapchat URL, fetching media...");
      const mediaData = await downloader.downloadSnapchatMedia(resolvedUrl);

      const mediaUrl = `${req.protocol}://${req.get(
        "host"
      )}/downloads/${path.basename(mediaData.filename)}`;

      return res.json({
        success: true,
        type: "snapchat",
        url: mediaUrl,
        metadata: {
          title: mediaData.metadata.title,
          uploader: mediaData.metadata.uploader,
          stats: {
            views: mediaData.metadata.stats.views,
            likes: mediaData.metadata.stats.likes,
          },
          description: mediaData.metadata.description,
          uploadDate: mediaData.metadata.uploadDate,
          quality: mediaData.metadata.quality,
          duration: mediaData.metadata.duration,
        },
        fileInfo: {
          fileName: path.basename(mediaData.filename),
          fileSize: fs.statSync(mediaData.filename).size,
          outputPath: mediaData.filename,
        },
      });
    }

    const fileName = `${uuidv4()}.mp4`;
    const outputPath = path.join(__dirname, "./downloads", fileName);

    console.log("Starting video download...", { url, outputPath });

    const info = await downloader.getInfo(resolvedUrl);
    const { stdout, stderr } = await downloader.download(
      resolvedUrl,
      outputPath
    );

    const videoUrl = `${req.protocol}://${req.get(
      "host"
    )}/downloads/${fileName}`;

    res.json({
      success: true,
      type: "video",
      url: videoUrl,
      title: info.title,
      description: info.description,
      creator: info.uploader,
      creatorUrl: info.uploader_url,
      stats: {
        likes: info.like_count,
        shares: info.repost_count,
        comments: info.comment_count,
        views: info.view_count,
      },
      thumbnail: info.thumbnail,
      duration: info.duration,
      uploadDate: info.upload_date,
      fileInfo: {
        fileName,
        fileSize: fs.statSync(outputPath).size,
        outputPath,
      },
    });
  } catch (error) {
    console.error("Download error:", error);
    res.status(500).json({
      error: error.message,
      details:
        "Please make sure the URL is valid and the video is under 5 minutes",
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log("Downloads directory:", path.join(__dirname, "./downloads"));
});