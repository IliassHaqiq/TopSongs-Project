const express = require("express");
const axios = require("axios");
const xml2js = require("xml2js");
const { MongoClient } = require("mongodb");

const app = express();
const PORT = 3000;
// Avoid conditional GET / ETag behaviour so the frontend always receives JSON body.
app.set("etag", false);

const MONGO_URL = "mongodb://mongodb:27017";
const DB_NAME = "musicdb";
const COLLECTION_NAME = "topsongs"; 

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(retries = 10, delay = 3000) {
  for (let i = 1; i <= retries; i++) {
    try {
      const client = new MongoClient(MONGO_URL);
      await client.connect();
      console.log("Connected to MongoDB");
      return client;
    } catch (error) {
      console.log(`MongoDB connection attempt ${i}/${retries} failed`);
      console.log(error.message);
      if (i === retries) throw error;
      await wait(delay);
    }
  }
}

async function fetchTopSongsFromItunes() {
  const url =
    "http://ax.itunes.apple.com/WebObjects/MZStoreServices.woa/ws/RSS/topsongs/limit=10/xml";

  const response = await axios.get(url);
  const parser = new xml2js.Parser({ explicitArray: true });
  const result = await parser.parseStringPromise(response.data);

  const entries = result.feed.entry || [];

  return entries.map((entry, index) => {
    const images = entry["im:image"] || [];
    const bestImage =
      images.length > 0 ? images[images.length - 1]._ || images[images.length - 1] : "";

    const links = entry.link || [];
    let songLink = "";
    let previewLink = "";

    for (const link of links) {
      const attrs = link.$ || {};
      if (attrs.rel === "alternate" && attrs.href) {
        songLink = attrs.href;
      }
      if (attrs.rel === "enclosure" && attrs.href) {
        previewLink = attrs.href;
      }
    }

    return {
      rank: index + 1,
      title: entry["im:name"] ? entry["im:name"][0] : "Unknown title",
      artist: entry["im:artist"] ? entry["im:artist"][0]._ || entry["im:artist"][0] : "Unknown artist",
      image: bestImage,
      songLink,
      previewLink,
      createdAt: new Date()
    };
  });
}

async function seedSongs() {
  const client = await connectWithRetry();

  try {
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);

    const songs = await fetchTopSongsFromItunes();

    await collection.deleteMany({});
    await collection.insertMany(songs);

    console.log("Top songs inserted into MongoDB");
  } finally {
    await client.close();
  }
}

app.get("/songs", async (req, res) => {
  let client;

  try {
    client = await connectWithRetry();
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);

    const songs = await collection.find().sort({ rank: 1 }).toArray();
    res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.json(songs);
  } catch (error) {
    console.error("Error in /songs:", error.message);
    res.status(500).json({ error: "Unable to fetch songs" });
  } finally {
    if (client) {
      await client.close();
    }
  }
});

app.get("/", (req, res) => {
  res.send("Backend is running");
});

app.listen(PORT, async () => {
  console.log(`Backend listening on port ${PORT}`);

  try {
    await seedSongs();
  } catch (error) {
    console.error("Failed to seed songs:", error.message);
  }
});