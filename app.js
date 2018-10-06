"use strict";
const express = require('express');
const ws = require('ws');
const Player = require('./player');
const app = express();
const port = process.env.PORT || 8008;
const server = require('http').createServer();
const wsServer = new ws.Server({server});

server.on('request', app);
app.post('/newbot', (req, res) => { 
  new Player()
  res.send('New bot!');
});

wsServer.on('connection', function(ws) {
  console.log('connection received', ws);
  ws.on('message', function incoming(message) {
    console.log('message', message);
  });
  ws.send('connect');
});

server.listen(port, () => console.log(`Server listening on ${port}`));
