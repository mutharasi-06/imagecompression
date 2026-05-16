const express = require("express");
const multer  = require("multer");
const fs      = require("fs");
const path    = require("path");

const app = express();

// ── Serve frontend files ──────────────────────────────
app.use(express.static("views"));

// ── Ensure folders exist ──────────────────────────────
const uploadDir     = path.join(__dirname, "uploads");
const compressedDir = path.join(__dirname, "compressed");

[uploadDir, compressedDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Multer storage ────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

// ── MIME type map ─────────────────────────────────────
const MIME_MAP = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png",  ".gif": "image/gif",
    ".bmp": "image/bmp",  ".webp": "image/webp",
    ".tiff": "image/tiff",".tif":  "image/tiff"
};


// ════════════════════════════════════════════════════════
//  HUFFMAN COMPRESSION
// ════════════════════════════════════════════════════════

function buildHuffmanCodes(data) {
    const freq = {};
    data.forEach(val => { freq[val] = (freq[val] || 0) + 1; });

    // Single unique byte edge-case
    if (Object.keys(freq).length === 1) {
        const [val] = Object.keys(freq);
        return { codes: { [val]: "0" }, freq };
    }

    let nodes = Object.entries(freq).map(([val, f]) => ({
        val: Number(val), f, left: null, right: null
    }));

    while (nodes.length > 1) {
        nodes.sort((a, b) => a.f - b.f || a.val - b.val);
        const left  = nodes.shift();
        const right = nodes.shift();
        nodes.push({ val: null, f: left.f + right.f, left, right });
    }

    const codes = {};
    function generate(node, code = "") {
        if (node.left === null && node.right === null) {
            codes[node.val] = code || "0"; return;
        }
        generate(node.left,  code + "0");
        generate(node.right, code + "1");
    }
    generate(nodes[0]);
    return { codes, freq };
}

function packBits(bitStr) {
    const padBits = (8 - (bitStr.length % 8)) % 8;
    const padded  = bitStr + "0".repeat(padBits);
    const bytes   = [];
    for (let i = 0; i < padded.length; i += 8)
        bytes.push(parseInt(padded.slice(i, i + 8), 2));
    return { packedBuffer: Buffer.from(bytes), padBits };
}

/**
 * .huff binary layout:
 *  [0-3]  "HUFF"  (magic)
 *  [4]    padBits (uint8)
 *  [5-8]  origLen (uint32 BE)
 *  [9-12] freqLen (uint32 BE)
 *  [13..] freq JSON (UTF-8)
 *  [..]   packed bits
 */
function buildHuffFile({ freq, padBits, origLen, packedBuffer }) {
    const magic    = Buffer.from("HUFF");
    const freqJSON = Buffer.from(JSON.stringify(freq), "utf8");
    const header   = Buffer.alloc(9);
    header.writeUInt8(padBits, 0);
    header.writeUInt32BE(origLen,         1);
    header.writeUInt32BE(freqJSON.length, 5);
    return Buffer.concat([magic, header, freqJSON, packedBuffer]);
}


// ════════════════════════════════════════════════════════
//  HUFFMAN DECOMPRESSION
// ════════════════════════════════════════════════════════

function buildTreeFromFreq(freq) {
    let nodes = Object.entries(freq).map(([val, f]) => ({
        val: Number(val), f, left: null, right: null
    }));
    if (nodes.length === 1) return nodes[0];
    while (nodes.length > 1) {
        nodes.sort((a, b) => a.f - b.f || a.val - b.val);
        const left  = nodes.shift();
        const right = nodes.shift();
        nodes.push({ val: null, f: left.f + right.f, left, right });
    }
    return nodes[0];
}

function decompressHuff(huffBuf) {
    if (huffBuf.slice(0, 4).toString("ascii") !== "HUFF")
        throw new Error("Invalid .huff file — not created by this server.");

    const padBits = huffBuf.readUInt8(4);
    const origLen = huffBuf.readUInt32BE(5);
    const freqLen = huffBuf.readUInt32BE(9);
    const freq    = JSON.parse(huffBuf.slice(13, 13 + freqLen).toString("utf8"));
    const packed  = huffBuf.slice(13 + freqLen);
    const root    = buildTreeFromFreq(freq);

    // Unpack bytes → bit string
    let bitStr = "";
    for (const byte of packed) bitStr += byte.toString(2).padStart(8, "0");
    if (padBits > 0) bitStr = bitStr.slice(0, -padBits);

    // Single-symbol edge case
    if (root.left === null && root.right === null) {
        return Buffer.from(Array(origLen).fill(root.val));
    }

    // Decode
    const decoded = [];
    let node = root;
    for (const bit of bitStr) {
        node = bit === "0" ? node.left : node.right;
        if (node.left === null && node.right === null) {
            decoded.push(node.val);
            node = root;
            if (decoded.length === origLen) break;
        }
    }

    if (decoded.length !== origLen)
        throw new Error(`Length mismatch: got ${decoded.length}, expected ${origLen}`);

    return Buffer.from(decoded);
}


// ════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════

// ── POST /upload  – compress image ───────────────────
app.post("/upload", upload.single("image"), (req, res) => {
    try {
        if (!req.file) return res.status(400).send("No file uploaded.");

        const origPath    = req.file.path;           // saved original
        const buffer      = fs.readFileSync(origPath);
        const data        = Array.from(buffer);
        const origLen     = data.length;

        // Build Huffman codes
        const { codes, freq } = buildHuffmanCodes(data);

        // Encode
        let bitStr = "";
        data.forEach(byte => { bitStr += codes[byte]; });

        // Pack into binary
        const { packedBuffer, padBits } = packBits(bitStr);
        const huffBuf = buildHuffFile({ freq, padBits, origLen, packedBuffer });

        // Save .huff file
        const huffName = req.file.filename + ".huff";
        fs.writeFileSync(path.join(compressedDir, huffName), huffBuf);

        // ── Pass real stats + the original upload filename ──
        res.redirect(
            `/result.html` +
            `?file=${encodeURIComponent(huffName)}` +
            `&orig=${encodeURIComponent(req.file.filename)}` +   // ← key: uploaded filename
            `&origName=${encodeURIComponent(req.file.originalname)}` +
            `&origSize=${origLen}` +
            `&compSize=${huffBuf.length}`
        );
    } catch (err) {
        console.error("Compression error:", err);
        res.status(500).send("Error during compression: " + err.message);
    }
});


// ── GET /image  – serve original uploaded image ───────
//    Used by result page to show "preview" of the image.
//    The image in uploads/  is the ORIGINAL (same bytes, just stored).
app.get("/image", (req, res) => {
    const safeFile = path.basename(req.query.file || "");
    if (!safeFile) return res.status(400).send("No file specified.");

    const filePath = path.join(uploadDir, safeFile);
    if (!fs.existsSync(filePath)) return res.status(404).send("Image not found.");

    // Derive MIME type from original extension embedded in filename
    // Filename pattern: {timestamp}-{originalname}
    const firstDash = safeFile.indexOf("-");
    const origName  = firstDash !== -1 ? safeFile.slice(firstDash + 1) : safeFile;
    const ext       = path.extname(origName).toLowerCase();
    const mime      = MIME_MAP[ext] || "application/octet-stream";

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `inline; filename="${origName}"`);
    res.sendFile(filePath);
});


// ── GET /download-image  – force-download original ────
app.get("/download-image", (req, res) => {
    const safeFile = path.basename(req.query.file || "");
    if (!safeFile) return res.status(400).send("No file specified.");

    const filePath = path.join(uploadDir, safeFile);
    if (!fs.existsSync(filePath)) return res.status(404).send("Image not found.");

    const firstDash = safeFile.indexOf("-");
    const origName  = firstDash !== -1 ? safeFile.slice(firstDash + 1) : safeFile;

    res.download(filePath, origName);
});


// ── GET /preview  – decompress .huff → image ─────────
//    Inline: /preview?file=xxx.huff
//    Download: /preview?file=xxx.huff&dl=1
app.get("/preview", (req, res) => {
    const safeFile = path.basename(req.query.file || "");
    if (!safeFile) return res.status(400).send("No file specified.");

    const filePath = path.join(compressedDir, safeFile);
    if (!fs.existsSync(filePath)) return res.status(404).send("Compressed file not found.");

    try {
        const huffBuf   = fs.readFileSync(filePath);
        const imgBuffer = decompressHuff(huffBuf);

        const withoutHuff = safeFile.replace(/\.huff$/, "");
        const firstDash   = withoutHuff.indexOf("-");
        const origName    = firstDash !== -1 ? withoutHuff.slice(firstDash + 1) : withoutHuff;
        const ext         = path.extname(origName).toLowerCase();
        const mime        = MIME_MAP[ext] || "application/octet-stream";

        res.setHeader("Content-Type", mime);
        res.setHeader("Content-Disposition",
            req.query.dl === "1"
                ? `attachment; filename="${origName}"`
                : `inline; filename="${origName}"`
        );
        res.send(imgBuffer);
    } catch (err) {
        console.error("Decompression error:", err);
        res.status(500).send("Decompression failed: " + err.message);
    }
});


// ── GET /download  – raw .huff file ──────────────────
app.get("/download", (req, res) => {
    const safeFile = path.basename(req.query.file || "");
    if (!safeFile) return res.status(400).send("No file specified.");
    const filePath = path.join(compressedDir, safeFile);
    fs.existsSync(filePath)
        ? res.download(filePath, safeFile)
        : res.status(404).send("File not found!");
});


// ── Start ─────────────────────────────────────────────
const server = app.listen(3000, () => {
    console.log("╔══════════════════════════════════════════╗");
    console.log("║  ✅  HuffPress running on port 3000      ║");
    console.log("║  http://localhost:3000                   ║");
    console.log("╠══════════════════════════════════════════╣");
    console.log("║  Routes loaded:                          ║");
    console.log("║   POST /upload                           ║");
    console.log("║   GET  /image        (preview image)     ║");
    console.log("║   GET  /download-image (save image)      ║");
    console.log("║   GET  /preview      (decompress .huff)  ║");
    console.log("║   GET  /download     (save .huff)        ║");
    console.log("╚══════════════════════════════════════════╝");
});

server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        console.error("❌  Port 3000 is already in use!");
        console.error("   Run this to kill it, then restart:");
        console.error("   Windows: netstat -ano | findstr :3000");
        console.error("            taskkill /PID <PID> /F");
    } else {
        console.error("Server error:", err);
    }
    process.exit(1);
});