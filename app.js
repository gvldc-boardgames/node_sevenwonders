"use strict";
const url = require('url');
const express = require('express');
const app = express();
const port = process.env.PORT || 8008;
const server = require('http').createServer();
const wssSevenWonders = require('./seven_wonders/ws_server').wss;
const Game = require('./seven_wonders/models/game');
const botFactory = require('./seven_wonders/models/bot_factory');

const autoGame = async () => {
  console.log('prep new game');
  const players = 3 + Math.floor(Math.random() * 5);
  const creator = botFactory({name: 'Bot #0', id: 'bot0'});
  await creator.readyPromise;
  const game = new Game({name: 'BotsOnly', maxPlayers: players, creator: creator.id, creatorName: creator.name})
  await game.readyPromise;
  await game.addPlayer(creator);
  for (let i = 1; i < players; i++) {
    await game.addBot(creator.id);
  }
  console.log('new game set', game.id, game.state);
}
const intervalId = setInterval(autoGame, 600000 * 3 / 4);
autoGame();
setTimeout(() => clearInterval(intervalId), 60000000 * 3 / 4);
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

app.get('/test', (req, res) => {console.log('testing'); res.send('ok'); });

server.listen(port, () => console.log(`Server listening on ${port}`));
