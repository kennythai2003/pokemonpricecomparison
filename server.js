const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, "cards.json");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function loadCards() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

function saveCards(cards) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(cards, null, 2));
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
    },
    timeout: 12000,
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status} for ${url}`);
    return null;
  }
  return res.text();
}

async function scrapePrice(url) {
  if (!url || url.trim() === "") return null;
  console.log("Fetching:", url);
  try {
    const html = await fetchHtml(url);
    if (!html) return null;
    const $ = cheerio.load(html);
    const selectors = [
      "#used_price td.price",
      "#used_price .price",
      "td#used_price",
      ".js-price",
    ];
    for (const sel of selectors) {
      const el = $(sel).first();
      if (el.length) {
        const text = el
          .text()
          .trim()
          .replace(/[^0-9.]/g, "");
        if (text && parseFloat(text) > 0) {
          console.log(`✓ $${text}`);
          return parseFloat(text);
        }
      }
    }
    return null;
  } catch (e) {
    console.error(`Error: ${e.message}`);
    return null;
  }
}

async function scrapeImage(url) {
  if (!url || url.trim() === "") return null;
  try {
    const html = await fetchHtml(url);
    if (!html) return null;
    const $ = cheerio.load(html);
    const img = $('img[itemprop="image"]').first().attr("src");
    return img || null;
  } catch (e) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// GET all cards
app.get("/api/cards", (req, res) => {
  res.json(loadCards());
});

// POST add a new card
app.post("/api/cards", (req, res) => {
  const { name, set, usLink, jpLink } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });
  const cards = loadCards();
  const newCard = {
    id: Date.now(),
    name,
    set: set || "",
    usLink: usLink || "",
    jpLink: jpLink || "",
    usPrice: null,
    jpPrice: null,
    diff: null,
    pctDiff: null,
    image: null,
  };
  cards.push(newCard);
  saveCards(cards);
  res.json(newCard);
});

// DELETE a card
app.delete("/api/cards/:id", (req, res) => {
  const cards = loadCards().filter((c) => c.id !== parseInt(req.params.id));
  saveCards(cards);
  res.json({ ok: true });
});

// POST fetch prices for all cards
app.post("/api/prices", async (req, res) => {
  let cards = loadCards();

  for (const card of cards) {
    // Fetch US page HTML once and reuse for both price and image
    const usHtml = card.usLink ? await fetchHtml(card.usLink) : null;
    await sleep(800);

    if (usHtml) {
      const $ = cheerio.load(usHtml);

      // Price from US page
      const selectors = [
        "#used_price td.price",
        "#used_price .price",
        "td#used_price",
        ".js-price",
      ];
      for (const sel of selectors) {
        const el = $(sel).first();
        if (el.length) {
          const text = el
            .text()
            .trim()
            .replace(/[^0-9.]/g, "");
          if (text && parseFloat(text) > 0) {
            card.usPrice = parseFloat(text);
            console.log(`✓ US $${text} - ${card.name}`);
            break;
          }
        }
      }

      // Image from US page
      const img = $('img[itemprop="image"]').first().attr("src");
      if (img) card.image = img;
    }

    // JP price
    card.jpPrice = await scrapePrice(card.jpLink);
    await sleep(800);

    card.diff =
      card.usPrice != null && card.jpPrice != null
        ? parseFloat((card.usPrice - card.jpPrice).toFixed(2))
        : null;
    card.pctDiff =
      card.usPrice != null && card.jpPrice != null && card.jpPrice !== 0
        ? parseFloat(
            (((card.usPrice - card.jpPrice) / card.jpPrice) * 100).toFixed(1),
          )
        : null;
  }

  saveCards(cards);
  res.json({ results: cards });
});

// POST import from CSV
app.post("/api/import", (req, res) => {
  const { cards: newCards } = req.body;
  const existing = loadCards();
  const merged = [...existing];
  for (const c of newCards) {
    const exists = merged.find((e) => e.name === c.name && e.set === c.set);
    if (!exists)
      merged.push({
        id: Date.now() + Math.random(),
        ...c,
        usPrice: null,
        jpPrice: null,
        diff: null,
        pctDiff: null,
        image: null,
      });
  }
  saveCards(merged);
  res.json({ results: merged });
});

app.listen(PORT, () => {
  console.log(`\n🃏 Card Price Tracker running at http://localhost:${PORT}\n`);
});
