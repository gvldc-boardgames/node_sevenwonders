"use strict";
const WebSocket = require('ws');
const wss = new WebSocket.Server({noServer: true});
const Player = require('./models/player');
const Game = require('./models/game');
let openGames = [];
let inProgressGames = [];

wss.on('connection', function(ws) {
  let player;
  let game;
  ws.on('message', function incoming(message) {
    let parsed = JSON.parse(message);
    if (parsed.messageType === 'login' && player == null) {
      player = new Player(parsed);
      player.readyPromise.then(resp => {
        ws.send(JSON.stringify({
          name: player.name, 
          id: player.id,
          messageType: 'myInfo',
          inGame: false
        }));
        openGames.forEach(game => {
          let data = {
            id: game.id,
            name: game.name,
            creator: game.creator,
            maxPlayers: game.maxPlayers,
            currentPlayers: game.players.length,
            messageType: 'newGame'
          };
          ws.send(JSON.stringify(data));
        });
      });
    } else if (parsed.messageType === 'newGame' && 
        game == null && player != null) {
      game = new Game(Object.assign(parsed, {creator: player.id}));
      game.addPlayer(player).then(function() {
        openGames.push(game);
        wss.clients.forEach(function(client) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            let data = {
              id: game.id,
              name: game.name,
              creator: game.creator,
              maxPlayers: game.maxPlayers,
              currentPlayers: game.players.length,
              messageType: 'newGame'
            };
            client.send(JSON.stringify(data));
          }
        });
      });
    }
  });
  ws.send('connected');
});

exports.wss = wss;
