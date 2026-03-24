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
        position INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Add position column if it doesn't exist (for existing databases)
    await pool.query(`
      ALTER TABLE cards ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0
    `);
    // Initialize positions for any cards that don't have one
    await pool.query(`
      UPDATE cards SET position = id WHERE position = 0 OR position IS NULL
    `);

    // Create sealed products table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sealed_products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        regular_link TEXT DEFAULT '',
        pokemon_center_link TEXT DEFAULT '',
        regular_price DECIMAL(10,2),
        pokemon_center_price DECIMAL(10,2),
        diff DECIMAL(10,2),
        pct_diff DECIMAL(10,2),
        image TEXT,
        position INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Initialize positions for sealed products
    await pool.query(`
      UPDATE sealed_products SET position = id WHERE position = 0 OR position IS NULL
    `);

    // Create collection table (cards you own)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS collection (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        set_name VARCHAR(255) DEFAULT '',
        price DECIMAL(10,2),
        image TEXT,
        link TEXT DEFAULT '',
        position INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Initialize positions for collection
    await pool.query(`
      UPDATE collection SET position = id WHERE position = 0 OR position IS NULL
    `);

    // Create sealed collection table (sealed products you own)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sealed_collection (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        set_name VARCHAR(255) DEFAULT '',
        price DECIMAL(10,2),
        image TEXT,
        link TEXT DEFAULT '',
        position INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Initialize positions for sealed collection
    await pool.query(`
      UPDATE sealed_collection SET position = id WHERE position = 0 OR position IS NULL
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

// Helper to convert DB row to sealed product API format
function rowToSealed(row) {
  return {
    id: row.id,
    name: row.name,
    regularLink: row.regular_link,
    pokemonCenterLink: row.pokemon_center_link,
    regularPrice: row.regular_price ? parseFloat(row.regular_price) : null,
    pokemonCenterPrice: row.pokemon_center_price ? parseFloat(row.pokemon_center_price) : null,
    diff: row.diff ? parseFloat(row.diff) : null,
    pctDiff: row.pct_diff ? parseFloat(row.pct_diff) : null,
    image: row.image,
  };
}

// GET all cards
app.get("/api/cards", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM cards ORDER BY position ASC");
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
    // Get the max position to add new card at the end
    const maxPos = await pool.query("SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM cards");
    const nextPosition = maxPos.rows[0].next_pos;

    const result = await pool.query(
      `INSERT INTO cards (name, set_name, us_link, jp_link, position)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, set || "", usLink || "", jpLink || "", nextPosition]
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

// PUT reorder cards
app.put("/api/cards/reorder", async (req, res) => {
  const { cardIds } = req.body; // Array of card IDs in new order
  if (!cardIds || !Array.isArray(cardIds)) {
    return res.status(400).json({ error: "cardIds array is required" });
  }

  try {
    // Update each card's position based on its index in the array
    for (let i = 0; i < cardIds.length; i++) {
      await pool.query("UPDATE cards SET position = $1 WHERE id = $2", [i, cardIds[i]]);
    }
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
    const updated = await pool.query("SELECT * FROM cards ORDER BY position ASC");
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

    const result = await pool.query("SELECT * FROM cards ORDER BY position ASC");
    res.json({ results: result.rows.map(rowToCard) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// ==================== SEALED PRODUCTS API ====================

// GET all sealed products
app.get("/api/sealed", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sealed_products ORDER BY position ASC");
    res.json(result.rows.map(rowToSealed));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// POST add a new sealed product
app.post("/api/sealed", async (req, res) => {
  const { name, regularLink, pokemonCenterLink } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });

  try {
    const maxPos = await pool.query("SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM sealed_products");
    const nextPosition = maxPos.rows[0].next_pos;

    const result = await pool.query(
      `INSERT INTO sealed_products (name, regular_link, pokemon_center_link, position)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, regularLink || "", pokemonCenterLink || "", nextPosition]
    );
    res.json(rowToSealed(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// DELETE a sealed product
app.delete("/api/sealed/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM sealed_products WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// PUT reorder sealed products
app.put("/api/sealed/reorder", async (req, res) => {
  const { productIds } = req.body;
  if (!productIds || !Array.isArray(productIds)) {
    return res.status(400).json({ error: "productIds array is required" });
  }

  try {
    for (let i = 0; i < productIds.length; i++) {
      await pool.query("UPDATE sealed_products SET position = $1 WHERE id = $2", [i, productIds[i]]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// POST fetch prices for all sealed products
app.post("/api/sealed/prices", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sealed_products");
    const products = result.rows;

    for (const product of products) {
      let regularPrice = null;
      let pokemonCenterPrice = null;
      let image = null;

      // Fetch regular page HTML
      const regularHtml = product.regular_link ? await fetchHtml(product.regular_link) : null;
      await sleep(800);

      if (regularHtml) {
        const $ = cheerio.load(regularHtml);

        // Price from regular page
        const selectors = [
          "#used_price td.price",
          "#used_price .price",
          "td#used_price",
          ".js-price",
        ];
        for (const sel of selectors) {
          const el = $(sel).first();
          if (el.length) {
            const text = el.text().trim().replace(/[^0-9.]/g, "");
            if (text && parseFloat(text) > 0) {
              regularPrice = parseFloat(text);
              console.log(`✓ Regular $${text} - ${product.name}`);
              break;
            }
          }
        }

        // Image from regular page
        const img = $('img[itemprop="image"]').first().attr("src");
        if (img) image = img;
      }

      // Pokemon Center price
      pokemonCenterPrice = await scrapePrice(product.pokemon_center_link);
      await sleep(800);

      const diff =
        regularPrice != null && pokemonCenterPrice != null
          ? parseFloat((regularPrice - pokemonCenterPrice).toFixed(2))
          : null;
      const pctDiff =
        regularPrice != null && pokemonCenterPrice != null && pokemonCenterPrice !== 0
          ? parseFloat((((regularPrice - pokemonCenterPrice) / pokemonCenterPrice) * 100).toFixed(1))
          : null;

      // Update product in database
      await pool.query(
        `UPDATE sealed_products SET regular_price = $1, pokemon_center_price = $2, diff = $3, pct_diff = $4, image = $5 WHERE id = $6`,
        [regularPrice, pokemonCenterPrice, diff, pctDiff, image, product.id]
      );
    }

    // Return updated products
    const updated = await pool.query("SELECT * FROM sealed_products ORDER BY position ASC");
    res.json({ results: updated.rows.map(rowToSealed) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// ==================== COLLECTION API ====================

// Helper to convert DB row to collection item API format
function rowToCollectionItem(row) {
  return {
    id: row.id,
    name: row.name,
    set: row.set_name,
    price: row.price ? parseFloat(row.price) : null,
    image: row.image,
    link: row.link,
  };
}

// GET all collection items
app.get("/api/collection", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM collection ORDER BY position ASC");
    res.json(result.rows.map(rowToCollectionItem));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// POST add a new collection item
app.post("/api/collection", async (req, res) => {
  const { name, set, price, image, link } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });

  try {
    const maxPos = await pool.query("SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM collection");
    const nextPosition = maxPos.rows[0].next_pos;

    const result = await pool.query(
      `INSERT INTO collection (name, set_name, price, image, link, position)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, set || "", price || null, image || null, link || "", nextPosition]
    );
    res.json(rowToCollectionItem(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// DELETE a collection item
app.delete("/api/collection/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM collection WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// PUT update a collection item
app.put("/api/collection/:id", async (req, res) => {
  const { name, set, link } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });

  try {
    const result = await pool.query(
      `UPDATE collection SET name = $1, set_name = $2, link = $3 WHERE id = $4 RETURNING *`,
      [name, set || "", link || "", req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.json(rowToCollectionItem(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// POST bulk import collection items
app.post("/api/collection/import", async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: "items array is required" });
  }

  try {
    for (const item of items) {
      if (!item.name) continue;

      // Check if item already exists
      const existing = await pool.query(
        "SELECT id FROM collection WHERE name = $1 AND set_name = $2",
        [item.name, item.set || ""]
      );

      if (existing.rows.length === 0) {
        const maxPos = await pool.query("SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM collection");
        const nextPosition = maxPos.rows[0].next_pos;

        await pool.query(
          `INSERT INTO collection (name, set_name, link, position) VALUES ($1, $2, $3, $4)`,
          [item.name, item.set || "", item.link || "", nextPosition]
        );
      }
    }

    const result = await pool.query("SELECT * FROM collection ORDER BY position ASC");
    res.json({ results: result.rows.map(rowToCollectionItem) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// PUT reorder collection items
app.put("/api/collection/reorder", async (req, res) => {
  const { itemIds } = req.body;
  if (!itemIds || !Array.isArray(itemIds)) {
    return res.status(400).json({ error: "itemIds array is required" });
  }

  try {
    for (let i = 0; i < itemIds.length; i++) {
      await pool.query("UPDATE collection SET position = $1 WHERE id = $2", [i, itemIds[i]]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// POST fetch prices for all collection items
app.post("/api/collection/prices", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM collection");
    const items = result.rows;
    console.log(`📦 Fetching prices for ${items.length} collection items...`);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let price = null;
      let image = null;

      console.log(`[${i + 1}/${items.length}] Processing: ${item.name} | Link: ${item.link || "(no link)"}`);

      if (!item.link) {
        console.log(`  ⚠ No link provided, skipping price fetch`);
        continue;
      }

      const html = await fetchHtml(item.link);
      await sleep(800);

      if (!html) {
        console.log(`  ✗ Failed to fetch HTML from ${item.link}`);
        continue;
      }

      const $ = cheerio.load(html);

      // Price
      const selectors = [
        "#used_price td.price",
        "#used_price .price",
        "td#used_price",
        ".js-price",
      ];
      for (const sel of selectors) {
        const el = $(sel).first();
        if (el.length) {
          const text = el.text().trim().replace(/[^0-9.]/g, "");
          if (text && parseFloat(text) > 0) {
            price = parseFloat(text);
            console.log(`  ✓ Price: $${text}`);
            break;
          }
        }
      }

      if (!price) {
        console.log(`  ⚠ No price found on page`);
      }

      // Image
      const img = $('img[itemprop="image"]').first().attr("src");
      if (img) {
        image = img;
        console.log(`  ✓ Image found`);
      }

      // Update item in database
      await pool.query(
        `UPDATE collection SET price = $1, image = $2 WHERE id = $3`,
        [price, image, item.id]
      );
    }

    console.log(`✅ Collection price fetch complete`);

    // Return updated items
    const updated = await pool.query("SELECT * FROM collection ORDER BY position ASC");
    res.json({ results: updated.rows.map(rowToCollectionItem) });
  } catch (e) {
    console.error("Collection prices error:", e);
    res.status(500).json({ error: "Database error" });
  }
});

// ==================== SEALED COLLECTION API ====================

// Helper to convert DB row to sealed collection item API format
function rowToSealedCollectionItem(row) {
  return {
    id: row.id,
    name: row.name,
    set: row.set_name,
    price: row.price ? parseFloat(row.price) : null,
    image: row.image,
    link: row.link,
  };
}

// GET all sealed collection items
app.get("/api/sealed-collection", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sealed_collection ORDER BY position ASC");
    res.json(result.rows.map(rowToSealedCollectionItem));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// POST add a new sealed collection item
app.post("/api/sealed-collection", async (req, res) => {
  const { name, set, price, image, link } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });

  try {
    const maxPos = await pool.query("SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM sealed_collection");
    const nextPosition = maxPos.rows[0].next_pos;

    const result = await pool.query(
      `INSERT INTO sealed_collection (name, set_name, price, image, link, position)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, set || "", price || null, image || null, link || "", nextPosition]
    );
    res.json(rowToSealedCollectionItem(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// DELETE a sealed collection item
app.delete("/api/sealed-collection/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM sealed_collection WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// PUT update a sealed collection item
app.put("/api/sealed-collection/:id", async (req, res) => {
  const { name, set, link } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });

  try {
    const result = await pool.query(
      `UPDATE sealed_collection SET name = $1, set_name = $2, link = $3 WHERE id = $4 RETURNING *`,
      [name, set || "", link || "", req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.json(rowToSealedCollectionItem(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// POST bulk import sealed collection items
app.post("/api/sealed-collection/import", async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: "items array is required" });
  }

  try {
    for (const item of items) {
      if (!item.name) continue;

      // Check if item already exists
      const existing = await pool.query(
        "SELECT id FROM sealed_collection WHERE name = $1 AND set_name = $2",
        [item.name, item.set || ""]
      );

      if (existing.rows.length === 0) {
        const maxPos = await pool.query("SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM sealed_collection");
        const nextPosition = maxPos.rows[0].next_pos;

        await pool.query(
          `INSERT INTO sealed_collection (name, set_name, link, position) VALUES ($1, $2, $3, $4)`,
          [item.name, item.set || "", item.link || "", nextPosition]
        );
      }
    }

    const result = await pool.query("SELECT * FROM sealed_collection ORDER BY position ASC");
    res.json({ results: result.rows.map(rowToSealedCollectionItem) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// PUT reorder sealed collection items
app.put("/api/sealed-collection/reorder", async (req, res) => {
  const { itemIds } = req.body;
  if (!itemIds || !Array.isArray(itemIds)) {
    return res.status(400).json({ error: "itemIds array is required" });
  }

  try {
    for (let i = 0; i < itemIds.length; i++) {
      await pool.query("UPDATE sealed_collection SET position = $1 WHERE id = $2", [i, itemIds[i]]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

// POST fetch prices for all sealed collection items
app.post("/api/sealed-collection/prices", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sealed_collection");
    const items = result.rows;
    console.log(`📦 Fetching prices for ${items.length} sealed collection items...`);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let price = null;
      let image = null;

      console.log(`[${i + 1}/${items.length}] Processing: ${item.name} | Link: ${item.link || "(no link)"}`);

      if (!item.link) {
        console.log(`  ⚠ No link provided, skipping price fetch`);
        continue;
      }

      const html = await fetchHtml(item.link);
      await sleep(800);

      if (!html) {
        console.log(`  ✗ Failed to fetch HTML from ${item.link}`);
        continue;
      }

      const $ = cheerio.load(html);

      // Price
      const selectors = [
        "#used_price td.price",
        "#used_price .price",
        "td#used_price",
        ".js-price",
      ];
      for (const sel of selectors) {
        const el = $(sel).first();
        if (el.length) {
          const text = el.text().trim().replace(/[^0-9.]/g, "");
          if (text && parseFloat(text) > 0) {
            price = parseFloat(text);
            console.log(`  ✓ Price: $${text}`);
            break;
          }
        }
      }

      if (!price) {
        console.log(`  ⚠ No price found on page`);
      }

      // Image
      const img = $('img[itemprop="image"]').first().attr("src");
      if (img) {
        image = img;
        console.log(`  ✓ Image found`);
      }

      // Update item in database
      await pool.query(
        `UPDATE sealed_collection SET price = $1, image = $2 WHERE id = $3`,
        [price, image, item.id]
      );
    }

    console.log(`✅ Sealed collection price fetch complete`);

    // Return updated items
    const updated = await pool.query("SELECT * FROM sealed_collection ORDER BY position ASC");
    res.json({ results: updated.rows.map(rowToSealedCollectionItem) });
  } catch (e) {
    console.error("Sealed collection prices error:", e);
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
