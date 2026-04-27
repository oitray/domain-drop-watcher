import http from "node:http";
const responses = {
  "available.com": { status: ["available"] },
  "registered.com": { status: ["registered"], events: [{ eventAction: "registration", eventDate: "2020-01-01" }] },
};
const server = http.createServer((req, res) => {
  const m = req.url.match(/\/domain\/(.+)$/);
  const domain = m && m[1];
  const data = responses[domain] || { status: ["unknown"] };
  res.writeHead(200, { "content-type": "application/rdap+json" });
  res.end(JSON.stringify(data));
});
server.listen(9999, () => console.log("rdap fixture on :9999"));
