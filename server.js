const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const requested = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));

  if (!requested.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(requested, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (fallbackErr, fallbackData) => {
        if (fallbackErr) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fallbackData);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(requested)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Order Growth Partners listening on port ${PORT}`);
});
