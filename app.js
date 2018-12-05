"use strict";
const url = require('url');
const express = require('express');
const Player = require('./player');
const app = express();
const port = process.env.PORT || 8008;
const server = require('http').createServer();
const wssSevenWonders = require('./seven_wonders/ws_server').wss;

server.on('request', app);

server.on('upgrade', function upgrade(req, sock, head) {
  console.log('upgrade', req.url);
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/seven_wonders') {
    wssSevenWonders.handleUpgrade(req, sock, head, function done(ws) {
      wssSevenWonders.emit('connection', ws, req);
    });
  } else {
    sock.destroy();
  }
});

app.post('/newbot', (req, res) => { 
  new Player();
  res.end('Bot added');
});

server.listen(port, () => console.log(`Server listening on ${port}`));
