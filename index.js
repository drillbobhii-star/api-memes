const express = require("express");
const dns = require("node:dns").promises;
const http = require("node:http");
const https = require("node:https");
const ipaddr = require("ipaddr.js");
const { Jimp } = require("jimp");

const app = express();

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const GRID_SIZE = 50;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_SOURCE_PIXELS = 25_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const WHITE_THRESHOLD = 245;
const ALPHA_THRESHOLD = 128;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

function isPublicAddress(address) {
  try {
    // "unicast" excludes private, loopback, link-local, multicast and reserved ranges.
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

async function resolvePublicHost(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "La URL debe usar HTTP o HTTPS.");
  }

  if (url.username || url.password) {
    throw new HttpError(400, "La URL no debe contener credenciales.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "");

  if (
    !normalizedHostname ||
    normalizedHostname === "localhost" ||
    normalizedHostname.endsWith(".localhost") ||
    normalizedHostname.endsWith(".local") ||
    normalizedHostname.endsWith(".internal")
  ) {
    throw new HttpError(400, "El host de la URL no está permitido.");
  }

  let addresses;

  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new HttpError(400, "No se pudo resolver el dominio de la URL.");
  }

  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new HttpError(400, "La URL debe apuntar a una dirección IP pública.");
  }

  return { hostname: normalizedHostname, addresses };
}

function requestBuffer(url, resolvedHost) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let settled = false;

    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const request = client.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        headers: {
          Accept: "image/*",
          "Accept-Encoding": "identity",
          "User-Agent": "AutoDraw-Image-Converter/1.0",
        },
        // Pin the request to the DNS results already validated above.
        lookup: (requestedHost, options, callback) => {
          const normalizedRequestHost = requestedHost
            .toLowerCase()
            .replace(/\.$/, "");

          if (normalizedRequestHost !== resolvedHost.hostname) {
            return callback(new Error("El host de conexión no coincide."));
          }

          if (options && options.all) {
            return callback(null, resolvedHost.addresses);
          }

          const selected = resolvedHost.addresses[0];
          return callback(null, selected.address, selected.family);
        },
      },
      (response) => {
        const chunks = [];
        let receivedBytes = 0;
        const contentLength = Number(response.headers["content-length"]);

        if (
          Number.isFinite(contentLength) &&
          contentLength > MAX_DOWNLOAD_BYTES
        ) {
          response.destroy();
          request.destroy(
            new HttpError(400, "La imagen supera el límite de 8 MB.")
          );
          return;
        }

        response.on("data", (chunk) => {
          receivedBytes += chunk.length;

          if (receivedBytes > MAX_DOWNLOAD_BYTES) {
            response.destroy();
            request.destroy(
              new HttpError(400, "La imagen supera el límite de 8 MB.")
            );
            return;
          }

          chunks.push(chunk);
        });

        response.on("end", () => {
          if (!settled) {
            settled = true;
            resolve({
              statusCode: response.statusCode || 0,
              headers: response.headers,
              body: Buffer.concat(chunks, receivedBytes),
            });
          }
        });

        response.on("error", fail);
      }
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(
        new HttpError(504, "La descarga de la imagen agotó el tiempo límite.")
      );
    });

    request.on("error", fail);
    request.end();
  });
}

async function downloadImage(urlValue) {
  let currentUrl;

  try {
    currentUrl = new URL(urlValue);
  } catch {
    throw new HttpError(400, "La URL proporcionada no es válida.");
  }

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const resolvedHost = await resolvePublicHost(currentUrl);
    const response = await requestBuffer(currentUrl, resolvedHost);

    const isRedirect = [301, 302, 303, 307, 308].includes(
      response.statusCode
    );

    if (isRedirect) {
      const location = response.headers.location;

      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new HttpError(400, "La URL tiene demasiadas redirecciones o una redirección inválida.");
      }

      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        throw new HttpError(400, "El servidor devolvió una redirección inválida.");
      }

      continue;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      if (response.statusCode >= 500) {
        throw new HttpError(502, "El servidor de imágenes devolvió un error.");
      }

      throw new HttpError(400, "No se pudo descargar la imagen desde esa URL.");
    }

    const contentType = String(response.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();

    if (contentType && !contentType.startsWith("image/")) {
      throw new HttpError(400, "El enlace no apunta a un archivo de imagen.");
    }

    if (!response.body.length) {
      throw new HttpError(400, "El archivo descargado está vacío.");
    }

    return response.body;
  }

  throw new HttpError(400, "No se pudo completar la descarga de la imagen.");
}

function extractPixels(image) {
  const pixels = [];
  const { data, width, height } = image.bitmap;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;

      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const alpha = data[offset + 3];

      // Ignore transparent and mostly transparent pixels.
      if (alpha <= ALPHA_THRESHOLD) continue;

      // Ignore near-white pixels to reduce the payload.
      if (
        r >= WHITE_THRESHOLD &&
        g >= WHITE_THRESHOLD &&
        b >= WHITE_THRESHOLD
      ) {
        continue;
      }

      pixels.push({ x, y, r, g, b });
    }
  }

  return pixels;
}

app.disable("x-powered-by");

app.get("/", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/convert", async (req, res, next) => {
  try {
    const url = req.query.url;

    if (typeof url !== "string" || !url.trim()) {
      throw new HttpError(400, 'Falta el parámetro obligatorio "url".');
    }

    if (url.length > 2048) {
      throw new HttpError(400, "La URL supera el máximo permitido de 2048 caracteres.");
    }

    const imageBuffer = await downloadImage(url.trim());

    let image;

    try {
      image = await Jimp.read(imageBuffer);
    } catch {
      throw new HttpError(400, "El archivo descargado no es una imagen válida o su formato no es compatible.");
    }

    const originalWidth = image.bitmap.width;
    const originalHeight = image.bitmap.height;

    if (
      !originalWidth ||
      !originalHeight ||
      originalWidth * originalHeight > MAX_SOURCE_PIXELS
    ) {
      throw new HttpError(400, "La imagen tiene dimensiones inválidas o demasiado grandes.");
    }

    // Normalize every source image to exactly 50 x 50 pixels.
    image.resize({ w: GRID_SIZE, h: GRID_SIZE });

    const pixels = extractPixels(image);

    // Successful responses contain exactly these three top-level properties.
    return res.status(200).json({
      width: GRID_SIZE,
      height: GRID_SIZE,
      pixels,
    });
  } catch (error) {
    return next(error);
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Ruta no encontrada." });
});

app.use((error, _req, res, _next) => {
  const statusCode =
    error instanceof HttpError ? error.statusCode : 500;

  if (statusCode >= 500) {
    console.error("[API] Error interno:", error.message);
  }

  return res.status(statusCode).json({
    error:
      error instanceof HttpError
        ? error.message
        : "Error interno del servidor al procesar la imagen.",
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API de conversión activa en el puerto ${PORT}`);
});
