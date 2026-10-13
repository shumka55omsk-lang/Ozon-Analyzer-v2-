const config = require('../config/bath-pricing.json');

module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ok:false, error:'Только чтение'}));
  }
  res.statusCode = 200;
  res.end(JSON.stringify({ok:true, dryRun:true, policy:config}));
};
