const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Initialize database table
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cards (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        set_name VARCHAR(255) DEFAULT '',
        us_link TEXT DEFAULT '',
        jp_link TEXT DEFAULT '',
        us_price DECIMAL(10,2),
        jp_price DECIMAL(10,2),
        diff DECIMAL(10,2),
        pct_diff DECIMAL(10,2),
        image TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("Database initialized");
  } catch (e) {
    console.error("Database init error:", e.message);
    throw e;
  }
}

app.use(cors());
app.use(express.json());

// Health check endpoint - must be before static files
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// Root route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use(express.static(path.join(__dirname, "public")));

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Helper to convert DB row to API format
function rowToCard(row) {
  return {
    id: row.id,
    name: row.name,
    set: row.set_name,
    usLink: row.us_link,
    jpLink: row.jp_link,
    usPrice: row.us_price ? parseFloat(row.us_price) : null,
    jpPrice: row.jp_price ? parseFloat(row.jp_price) : null,
    diff: row.diff ? parseFloat(row.diff) : null,
    pctDiff: row.pct_diff ? parseFloat(row.pct_diff) : null,
    image: row.image,
  };
}

// GET all cards
app.get("/api/cards", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM cards ORDER BY created_at DESC");
    res.json(result.rows.map(rowToCard));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// POST add a new card
app.post("/api/cards", async (req, res) => {
  const { name, set, usLink, jpLink } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });

  try {
    const result = await pool.query(
      `INSERT INTO cards (name, set_name, us_link, jp_link)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, set || "", usLink || "", jpLink || ""]
    );
    res.json(rowToCard(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// DELETE a card
app.delete("/api/cards/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM cards WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// POST fetch prices for all cards
app.post("/api/prices", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM cards");
    const cards = result.rows;

    for (const card of cards) {
      let usPrice = null;
      let jpPrice = null;
      let image = null;

      // Fetch US page HTML once and reuse for both price and image
      const usHtml = card.us_link ? await fetchHtml(card.us_link) : null;
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
              usPrice = parseFloat(text);
              console.log(`✓ US $${text} - ${card.name}`);
              break;
            }
          }
        }

        // Image from US page
        const img = $('img[itemprop="image"]').first().attr("src");
        if (img) image = img;
      }

      // JP price
      jpPrice = await scrapePrice(card.jp_link);
      await sleep(800);

      const diff =
        usPrice != null && jpPrice != null
          ? parseFloat((usPrice - jpPrice).toFixed(2))
          : null;
      const pctDiff =
        usPrice != null && jpPrice != null && jpPrice !== 0
          ? parseFloat((((usPrice - jpPrice) / jpPrice) * 100).toFixed(1))
          : null;

      // Update card in database
      await pool.query(
        `UPDATE cards SET us_price = $1, jp_price = $2, diff = $3, pct_diff = $4, image = $5 WHERE id = $6`,
        [usPrice, jpPrice, diff, pctDiff, image, card.id]
      );
    }

    // Return updated cards
    const updated = await pool.query("SELECT * FROM cards ORDER BY created_at DESC");
    res.json({ results: updated.rows.map(rowToCard) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// POST import from CSV
app.post("/api/import", async (req, res) => {
  const { cards: newCards } = req.body;

  try {
    for (const c of newCards) {
      // Check if card already exists
      const existing = await pool.query(
        "SELECT id FROM cards WHERE name = $1 AND set_name = $2",
        [c.name, c.set || ""]
      );

      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO cards (name, set_name, us_link, jp_link) VALUES ($1, $2, $3, $4)`,
          [c.name, c.set || "", c.usLink || "", c.jpLink || ""]
        );
      }
    }

    const result = await pool.query("SELECT * FROM cards ORDER BY created_at DESC");
    res.json({ results: result.rows.map(rowToCard) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// Initialize DB and start server
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🃏 Card Price Tracker running on port ${PORT}\n`);
  });
}).catch(e => {
  console.error("Failed to initialize database:", e);
  process.exit(1);
});
