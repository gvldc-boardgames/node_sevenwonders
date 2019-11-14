"use strict";
const WebSocket = require('ws');
const wss = new WebSocket.Server({noServer: true});
const Player = require('./models/player');
const Game = require('./models/game');
let openGames = [];
let inProgressGames = [];

const broadcast = function(data, ws) {
  wss.clients.forEach(function(client) {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', function(ws) {
  let player;
  let game;
  ws.on('message', function incoming(message) {
    let parsed = JSON.parse(message);
    if (parsed.messageType === 'login' && player == null) {
      player = new Player(Object.assign(parsed, {ws}));
      player.readyPromise.then(resp => {
        player.notify({
          name: player.name, 
          id: player.id,
          messageType: 'myInfo',
          inGame: false
        });
        openGames.forEach(game => {
          let data = {
            id: game.id,
            name: game.name,
            creator: game.creator,
            creatorName: game.creatorName,
            maxPlayers: game.maxPlayers,
            currentPlayers: game.players.length,
            messageType: 'newGame'
          };
          player.notify(data);
        });
      });
    } else if (parsed.messageType === 'newGame' && 
        game == null && player != null) {
      let gameParams = Object.assign(parsed,
          {creator: player.id, creatorName: player.name});
      game = new Game(gameParams);
      game.once('gameStart', () => {
        let data = {id: game.id, messageType: 'started'};
        openGames.splice(openGames.indexOf(game), 1);
        broadcast(data, ws);
      });
      game.addPlayer(player).then(function() {
        let data = {
          id: game.id,
          name: game.name,
          creator: game.creator,
          creatorName: game.creatorName,
          maxPlayers: game.maxPlayers,
          currentPlayers: game.players.length,
          messageType: 'newGame'
        };
        openGames.push(game);
        broadcast(data, ws);
      });
    } else if (parsed.messageType === 'joinGame'
        && game == null && player != null) {
      let gameJoined = openGames.filter(game => game.id === parsed.id)[0];
      if (gameJoined != null) {
        game = gameJoined;
        game.addPlayer(player);
      }
    } else if (parsed.messageType === 'addBot' && game != null 
        && player != null) {
      console.log('adding bot');
      game.addBot(player.id);
    }
  });
  ws.send(JSON.stringify({messageType: 'connected'}));
});

exports.wss = wss;
