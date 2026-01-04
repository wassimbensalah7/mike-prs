const { IgApiClient } = require('instagram-private-api');
const rp = require('request-promise');
const schedule = require('node-schedule');
const fs = require('fs');
const request = require('request');
const moment = require('moment-timezone');
const http = require('http');

// Load .env if present (optional)
try { require('dotenv').config(); } catch (e) { /* dotenv not installed; environment variables can be set externally */ }

// Config from environment
const accounts = (process.env.BOT_ACCOUNTS || 'public-insta-account-1,public-insta-account-2').split(',').map(a => a.trim());

// Start time (HH:MM) and posting window (hours)
const startTime = process.env.START_TIME || '21:00';
const [startHour, startMin] = startTime.split(':').map(s => parseInt(s, 10));
const postingHours = parseInt(process.env.POSTING_HOURS || '6', 10);

// Timezone for scheduling and display (IANA format), default to Algeria
const tz = process.env.TIMEZONE || 'Africa/Algiers';

// Instagram client setup
const ig = new IgApiClient();
const username = process.env.BOT_USERNAME || 'your-username-here';
const password = process.env.BOT_PASSWORD || 'your-password-here';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'your-rapid-api-key';

if (!username || !password || !RAPIDAPI_KEY) {
  console.error('Missing required env vars: BOT_USERNAME, BOT_PASSWORD, RAPIDAPI_KEY. Please set them and restart.');
  process.exit(1);
} 

// Function to choose a random caption
const captions = [
    'your captions',
    'another caption',
];

const getRandomCaption = () => captions[Math.floor(Math.random() * captions.length)];

let allVideos = []; // Array to hold video data from all accounts
let accountsProcessed = 0; // Counter to track the number of accounts processed

// Function to fetch videos from a specific Instagram account
function fetchVideos(accountName) {
    const options = {
        method: 'GET',
        url: `https://instagram-fast.p.rapidapi.com/feed/${accountName}`,
        headers: {
            'X-RapidAPI-Key': RAPIDAPI_KEY, // set RAPIDAPI_KEY via env var
            'X-RapidAPI-Host': 'instagram-fast.p.rapidapi.com'
        }
    }; 

    request(options, function (error, response, body) {
        if (error) throw new Error(error);

        const jsonResponse = JSON.parse(body);
        
        const nowInSeconds = Math.floor(Date.now() / 1000); // Current time in seconds since the Unix epoch

        const timeLimit = 23 * 3600 + 45 * 60; // 23 hours and 30 minutes in seconds

        // Filter for video posts within the last 23 hours and 30 minutes
        const videoPostsInfo = jsonResponse.data.user.edge_owner_to_timeline_media.edges
            .filter(edge => edge.node.is_video && (nowInSeconds - edge.node.taken_at_timestamp) <= timeLimit)
            .map(edge => {
                const randomFutureTimeInSeconds = Math.floor(Math.random() * (postingHours * 3600)); // Up to 10 hours in seconds and then in seconds 3600 in an hour
                const postTimeUnix = nowInSeconds + randomFutureTimeInSeconds; // Future Unix timestamp for post_time
                const realTimeInTz = moment.unix(postTimeUnix).tz(tz).format(); // Human-readable in configured timezone

                return {
                    taken_at_timestamp: edge.node.taken_at_timestamp,
                    display_url: edge.node.display_url,
                    video_url: edge.node.video_url,
                    owner: edge.node.owner,
                    post_time: postTimeUnix, // Future Unix timestamp (UTC)
                    real_time: realTimeInTz // Time in configured timezone
                }; 
            });

        allVideos = allVideos.concat(videoPostsInfo);
        
        accountsProcessed++;

        if (accountsProcessed === accounts.length) {
            saveAndScheduleAllVideos();
        }
    });
}

// Function to write all videos data to a single JSON file and then schedule posts
function saveAndScheduleAllVideos() {
    fs.writeFile('video.json', JSON.stringify(allVideos, null, 2), (err) => {
        if (err) throw err;
        console.log(`Filtered videos with post times and real times (${tz}) have been saved to one file!`);

        // If explicit immediate posting is requested, post now for all fetched videos
        const runNowImmediate = process.env.RUN_NOW_IMMEDIATE === '1' || process.argv.includes('--now-immediate');

        if (runNowImmediate) {
            console.log('RUN_NOW_IMMEDIATE set; attempting to post all fetched videos immediately.');
            (async () => {
                for (const video of allVideos) {
                    try {
                        console.log(`Posting immediately: ${video.video_url}`);
                        await postToInsta(video.video_url, video.display_url);
                    } catch (e) {
                        console.error('Error posting video immediately:', e.message || e);
                    }
                }
                console.log('Immediate posting batch completed.');
            })();
        } else {
            schedulePosts(); // Call the function to schedule posts after saving
        }
    });
}

// Function to download content
const downloadContent = async (url) => {
    const options = {
        uri: url,
        encoding: null,
    };
    return rp(options);
};

// Function to post a video to Instagram
async function postToInsta(videoUrl, displayUrl) {
    const isDryRun = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
    if (isDryRun) {
        console.log(`[DRY-RUN] Would post video: ${videoUrl}`);
        return;
    }

    ig.state.generateDevice(username);
    await ig.account.login(username, password);

    const [videoBuffer, coverImageBuffer] = await Promise.all([
        downloadContent(videoUrl),
        downloadContent(displayUrl),
    ]);

    const caption = getRandomCaption();

    await ig.publish.video({
        video: videoBuffer,
        coverImage: coverImageBuffer,
        caption: caption,
    });

    console.log('Video posted successfully');
}

// Function to schedule posts
const schedulePosts = () => {
    const videos = JSON.parse(fs.readFileSync('video.json', 'utf8'));

    videos.forEach(video => {
        // Convert UNIX timestamp to JavaScript Date object
        const postTime = new Date(video.post_time * 1000); // UNIX timestamp is in seconds, JavaScript Date needs milliseconds
        const currentTime = new Date();

        if (postTime > currentTime) {
            schedule.scheduleJob(postTime, function() {
                console.log(`Posting video scheduled for ${postTime}`);
                postToInsta(video.video_url, video.display_url).catch(console.error);
            });
        } else {
            console.log(`Skipping video scheduled for ${postTime} as it is in the past.`);
        }
    });
};

// Schedule daily operations at configured START_TIME in the configured timezone
schedule.scheduleJob({hour: startHour, minute: startMin, tz}, () => {
    console.log(`Starting Instagram video fetching and posting routine at ${String(startHour).padStart(2,'0')}:${String(startMin).padStart(2,'0')} (${tz}).`);
    accounts.forEach(account => {
        fetchVideos(account);
    });
});

// Optional immediate run flags (manual):
// - RUN_NOW=1 or --now => fetch accounts immediately
// - RUN_NOW_IMMEDIATE=1 or --now-immediate => fetch and POST immediately (live)
if (process.env.RUN_NOW === '1' || process.argv.includes('--now')) {
    console.log('RUN_NOW set; fetching videos immediately.');
    accounts.forEach(account => fetchVideos(account));
}

// Optional: Simple server setup if you need a running process for monitoring or other purposes
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Instagram automation server is running.\n');
});

server.listen(4000, () => {
  console.log('Server running at http://127.0.0.1:4000/');
});
