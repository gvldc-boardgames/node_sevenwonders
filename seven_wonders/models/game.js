"use strict";
const neo4j = require('neo4j-driver').v1;
const EventEmitter = require('events');
const Player = require('./player');
const cardHelper = require('./../../helpers/card_helper');

const driver = neo4j.driver(process.env.NEO4J_BOLT,
    neo4j.auth.basic('neo4j','BoardGames'),
    {disableLosslessIntegers: true});

class Game extends EventEmitter {
  constructor(options = {}) {
    super();
    this.creator = options.creator;
    this.creatorName = options.creatorName;
    this.maxPlayers = options.maxPlayers;
    this.name = options.name;
    this.id = options.id || `game-${Date.now()}`;
    this.gameType = 'SevenWonders';
    this.players = [];
    this.state = 'new';
    this.round = 1;
    this.age = 1;
    this.pendingPlays = {};
    this.wonderSides = {};
    this.playersInfo = {};
    this.playersHands = {};
    this.playOrder = [];
    this.setListeners();
    this.readyPromise = this.checkState();
  }

  addBot(playerId) {
    // only let the creator request a new bot
    if (playerId === this.creator && this.maxPlayers > this.players.length) {
      const bot = new Player({name: `Bot #${this.players.length}`, id: `bot${this.players.length}`});

      bot.once('wonderOption', (opt) => {
        const side = ['a', 'b'][Math.floor(Math.random() * 100) % 2];
        bot.chooseWonderSide({wonderName: opt.wonderName, side});
      });
      bot.on('hand', (hand) => bot.discardCard(hand[0]));
      this.addPlayer(bot);
      console.log('bot added');
    }
  }

  setListeners() {
    this.on('error', function(err) {
      console.log('error in game!', err);
    }).on('exit', function(data) {
      driver.close();
    });
  }

  setPlayerListeners(player) {
    // set up variables to use for listeners bound to "this" so they can be removed later
    // and still have proper scope
    const handlePlayCard = (player, card, cost) => this.handlePlayCard(player, card, cost);
    const handleBuildWonder = (player, card, cost) => this.handleBuildWonder(player, card, cost);
    const handleDiscard = (player, card) => this.handleDiscard(player, card);
    
    // set up listeners for events from player
    player.once('wonderSideChosen', (player, wonderSide) => {
      this.setWonderSide(player, wonderSide);
    }).on('playCard', handlePlayCard)
      .on('buildWonder', handleBuildWonder)
      .on('discard', handleDiscard);

    // on end of game, remove listeners
    this.on('gameEnd', function() {
      player.removeListener('playCard', handlePlayCard)
        .removeListener('buildWonder', handleBuildWonder)
        .removeListener('discard', handleDiscard);
    });
  }

  broadcast(data, player) {
    this.players.forEach(function(p) {
      if (p !== player) {
        p.notify(data);
      }
    });
  }

  async checkState() {
    let cypher = this.cypherSetupGame();
    let resp = await this.runQuery(cypher);
    let gameInfo = resp.records[0];
    if (gameInfo && gameInfo.get('gameType') === this.gameType) {
      if (gameInfo.get('state') === 'new') {
        this.maxPlayers = gameInfo.get('maxPlayers');
        if (gameInfo.get('currentPlayers') > 0)
          await this.getPlayers();
        this.age = gameInfo.get('age');
        this.round = gameInfo.get('round');
        this.wonderPromise = this.dealWonders();
        this.cardPromise = this.wonderPromise.then(() => {
          this.dealCards();
        });
        return 'new';
      } else {
        // state is not new
        // TODO: add resume
        throw new Error('Unhandled game state');
      }
    } else {
      // gameType mismatch
      throw new Error('Game type doesn\'t match');
    }
  }
  
  // convert numerical age to string AgeOne etc
  ageToString(age) {
    if (age == 1) {
      return "AgeOne";
    } else if (age == 2) {
      return "AgeTwo";
    } else if (age == 3) {
      return "AgeThree";
    } else {
      throw new Error('Unrecognized age');
    }
  }

  async addPlayer(player) {
    await this.readyPromise;
    if (this.players.length < this.maxPlayers) {
      if (this.players.indexOf(player) === -1) {
        let data = {name: player.name, id: player.id, messageType: 'newPlayer'};
        this.broadcast(data, player);
        this.players.push(player);
        data = {
          id: this.id,
          name: this.name,
          currentPlayer: player.name,
          maxPlayers: this.maxPlayers,
          players: this.players.map(p => {return {name: p.name, id: p.id}}),
          messageType: 'joinGame'
        };
        player.notify(data);
        this.setPlayerListeners(player);
        if (this.players.length === this.maxPlayers) {
          await this.wonderPromise;
          await this.runQuery(this.cypherSavePlayers());
          this.startGame();
        }
      }
    }
  }

  async startGame() {
    this.state = 'setup';
    this.getPlayOrder();
    let resp = await this.runQuery(this.cypherGetWonderOptions());
    let wonderOptions = [];
    this.emit('gameStart');
    for (let record of resp.records) {
      if (record) {
        wonderOptions.push({
          wonderName: record.get('wonderName'),
          playerId: record.get('playerId'),
          playerName: record.get('playerName'),
          wonderSides: record.get('wonderSides')
        });
      }
    }
    this.wonderOptions = wonderOptions;
    wonderOptions.forEach((wonderOption) => {
      this.players.filter(player => player.id === wonderOption.playerId).forEach((player) => {
        player.emit('wonderOption', wonderOption);
      });
    });
    await this.runQuery(this.cypherSaveState());
    await this.sendStartInfo();
  }

  // legacy support for start info -- scrap this later
  async sendStartInfo() {
    let resp = await this.runQuery(this.cypherGetStartInfo());
    let neighborsMap = {};
    for (let record of resp.records) {
      neighborsMap[record.get('playerId')] = record.get('neighbors');
    };
    let plinfo = this.players.map((player) => {
      return {
        cards: [],
        coins: 3,
        id: player.id,
        military: {'1': 0, '3': 0, '5': 0, '-1': 0},
        name: player.name,
        wonder: {
          name: player.wonderOption.wonderName,
          stage: 0,
          side: null
        }
      };
    });
    this.players.forEach((player) => {
      let data = {
        coins: 3,
        leftcards: [],
        messageType: 'startInfo',
        military: {'1': 0, '3': 0, '5': 0, '-1': 0},
        neighbors: neighborsMap[player.id],
        played: [],
        plinfo,
        rejoin: false,
        rightcards: [],
        wonder: {
          name: player.wonderOption.wonderName,
          stage: 0
        },
        wonderSide: null
      };
      player.notify(data);
    });
  }

  async getPlayers() {
    // TODO: decide how to handle rejoining/resuming WRT players
    return false;
  }

  async dealWonders() {
    let records = (await this.runQuery(this.cypherGetWonders())).records;
    let wonders = [];
    for (let record of records)
      wonders.push(record.get('name'));
    wonders = cardHelper.shuffleCards(wonders);
    this.wonders = cardHelper.deal(wonders, 1, this.maxPlayers)[0];
    await this.saveWonders();
  }

  async saveWonders() {
    await this.runQuery(this.cypherSaveWonders(this.wonders));
  }

  async dealCards() {
    let cardsDealt = await this.cardsDealt();
    // make sure not to deal out cards more than once
    if (!cardsDealt) {
      // one age at a time to prevent race condition for freeBuilds
      await this.dealAge('AgeOne');
      await this.dealAge('AgeTwo');
      await this.dealAge('AgeThree');
    }
  }

  async cardsDealt() {
    let result = await this.runQuery(this.cypherCountCards());
    return result.records[0].get('cardsDealt') != 0;
  }

  async dealAge(age) {
    let cards = [];
    let hands = [];
    let result = await this.runQuery(this.cypherGetCards(age));
    result.records.forEach((record) => {
      cards.push({
        name: record.get('name'),
        players: record.get('players')
      });
    });
    // AgeThree requires guilds
    if (age === 'AgeThree') {
      let guilds = [];
      result = await this.runQuery(this.cypherGetGuilds());
      result.records.forEach((record) => {
        guilds.push({
          name: record.get('name'),
          players: record.get('players')
        });
      });
      guilds = cardHelper.shuffleCards(guilds);
      guilds = cardHelper.deal(guilds, 1, this.maxPlayers + 2)[0];
      cards.push(...guilds);
    }

    cards = cardHelper.shuffleCards(cards);
    hands = cardHelper.deal(cards, this.maxPlayers, 7).map((hand, i) => {
      return {cards: hand, wonder: this.wonders[i]};
    });
    await this.runQuery(this.cypherSaveHands(age, hands));
  }

  async setWonderSide(player, wonderSide) {
    console.log('setWonderSide', player.id, player.name, wonderSide.wonderName, wonderSide.side);
    if (this.wonderSides[player.id] == null) {
      let wonderOption = this.wonderOptions.filter((option) => {
        return option.playerId === player.id &&
              option.wonderName === wonderSide.wonderName;
      })[0];
      if (wonderOption != null) {
        // player can actually choose this wonder
        let chosenSide = wonderOption.wonderSides
            .filter(s => s.side === wonderSide.side)[0];
        let wonder = {
          resource: chosenSide.resource,
          stages: chosenSide.stages,
          wonderName: wonderSide.wonderName,
          side: wonderSide.side
        };          
        this.wonderSides[player.id] = {
          playerId: player.id,
          wonderName: wonderSide.wonderName,
          side: wonderSide.side
        };
        this.broadcast({wonder, playerId: player.id,
            messageType: 'sideChosen'});
      } else {
        console.log('wonder not for you!');
        // player tried to play a wonder he doesn't have!
      }
    } else {
      console.log('side already chosen!')
      // player has already chosen a side
    }
    // check if all wonders played
    if (Object.keys(this.wonderSides).length === this.maxPlayers) {
      await this.runQuery(this.cypherSaveWonderOptions(Object.values(this.wonderSides)));
      await this.cardPromise;
      this.state = 'playing';
      await this.runQuery(this.cypherSaveState());
      console.log('start round one age 1');
      this.startRound()
    }
  }

  async startRound() {
    this.pendingPlays = {};
    this.playersHands = {};
    let playerInfoPromise = this.getPlayersInfo();
    let playerHandsPromise = this.getPlayersHands();
    await playerInfoPromise;
    this.players.forEach(player => player.emit('playersInfo', this.playersInfo));
    await playerHandsPromise;
    for (let [playerId, hand] of Object.entries(this.playersHands)) {
      if (hand.length > (8 - this.round)) console.log('too long hand!', hand);
      this.players.filter(player => player.id === playerId).forEach((player) => {
        player.emit('hand', hand);
      });
    }
  }

  getMaxScienceWithVariableScience(mappedValues) {
    const possibleValues = ['#', '@', '&'];
    let variableScience = mappedValues['&/@/#'] - 1;
    delete mappedValues['&/@/#'];
    let possiblePlays = possibleValues.map((v) => {
      if (mappedValues[v]) {
        return {...mappedValues, [v]: mappedValues[v] + 1};
      } else {
        return {...mappedValues, [v]: 1};
      }
    });
    for (; variableScience > 0; --variableScience) {
      console.log(possiblePlays, variableScience);
      possiblePlays = possiblePlays.map((currPlay) => {
        possibleValues.map((v) => {
          if (currPlay[v]) {
            return {...currPlay, [v]: currPlay[v] + 1};
          } else {
            return {...currPlay, [v]: 1};
          }
        })
      });
    }
    return Math.max(...possiblePlays.map(this.calculateScienceScoreFromMap));
  }

  calculateScienceScoreFromMap(mappedValues) {
    const sciCounts = Object.values(mappedValues);
    return sciCounts.reduce((acc, curr) => {
      return acc + (curr * curr);
    }, 0) + (sciCounts.length === 3 ? Math.min(...sciCounts) * 7 : 0);
  }

  calculateScienceScore(scienceValues) {
    const mappedValues = scienceValues.reduce((acc, curr) => {
      if (acc[curr] == null) {
        acc[curr] = 1;
      } else {
        ++acc[curr];
      }
      return acc;
    }, {});
    if (mappedValues['&/@/#'] != null) {
      return this.getMaxScienceWithVariableScience(mappedValues);
    } else {
      return this.calculateScienceScoreFromMap(mappedValues);
    }
  };

  async getPlayersInfo() {
    // reset playersInfo before fetching
    this.playersInfo = {};
    let resp = await this.runQuery(this.cypherGetPlayersInfo());
    resp.records.forEach((record) => {
      this.playersInfo[record.get('playerId')] = {
        playerId: record.get('playerId'),
        playerName: record.get('playerName'),
        wonderName: record.get('wonderName'),
        wonderSide: record.get('wonderSide'),
        wonderResource: record.get('wonderResource'),
        coins: record.get('coins'),
        military: record.get('military'),
        wonderPoints: record.get('wonderPoints'),
        cultural: record.get('cultural'),
        commercial: record.get('commercial'),
        guilds: record.get('guilds'),
        stagesInfo: record.get('stagesInfo'),
        clockwisePlayer: record.get('clockwisePlayer'),
        counterClockwisePlayer: record.get('counterClockwisePlayer'),
        scienceValues: record.get('scienceValues'),
        scienceScore: this.calculateScienceScore(record.get('scienceValues')),
      };
    });
    // separate call to get cards played
    resp = await this.runQuery(this.cypherGetPlayedCards());
    resp.records.forEach((record) => {
      this.playersInfo[record.get('playerId')].cardsPlayed = record.get('cards');
    });
  }

  async getPlayOrder() {
    let resp = await this.runQuery(this.cypherGetPlayOrder());
    this.playOrder = [];
    resp.records.forEach((record) => {
      this.playOrder.push(record.get('playerData'));
    });
    this.broadcast({playOrder: this.playOrder,
      messageType: 'playOrder',
      direction: this.age === 2 ? 'counterClockwise' : 'clockwise'
    });
  }

  async getPlayersHands() {
    let resp = await this.runQuery(this.cypherGetHandInfo());
    resp.records.forEach((record) => {
      let hand = record.get('hand');
      this.playersHands[record.get('playerId')] = hand;
    });
  }

  async endRound() {
    await this.savePendingPlays();
    await this.rotateHands();
    if (this.round === 6) {
      // end of age!
      this.endAge();
    } else {
      this.round++;
      this.startRound();
    }
    await this.runQuery(this.cypherSaveState());
  }

  async checkPoints(plays) {
    const blueCardPlays = plays.filter(p => p.cardColor === 'blue');
    if (blueCardPlays.length > 0) {
      const cyphers = blueCardPlays.map((play) => {
        const cypher = `
          MATCH (c:${this.ageToString(this.age)}CardInstance {name: $cardName, players: $players})-[:USED_IN]->(g:Game {gameId: $gameId})<-[:JOINS]-({playerId: $playerId})<-[:WONDER_FOR]-(w {name: $wonderName, gameId: $gameId})-[:SCORES]->(score:WonderScore)
          MERGE (c)-[:SCORES_POINTS {value: c.value}]->(score)
            ON CREATE SET score.cultural = score.cultural + coalesce(toInteger(c.value), 0)
        `;
        const params = {
          players: play.players,
          cardName: play.cardName,
          gameId: this.id,
          playerId: play.playerId,
          wonderName: play.wonderName,
        };
        return {query: cypher, params};
      });
      for (let i = 0; i < cyphers.length; i++) {
        await this.runQuery(cyphers[i]);
      }
    }
  };

  async checkCoins(plays) {
    const digitCheck = /\d/;
    const allDigits = /^\d+$/;
    const coinsAndVP = /\(\d+\)/;
    let valuablePlays = plays.filter((play) => {
      return play.cardColor === 'yellow' && digitCheck.test(play.cardValue);
    });
    if (valuablePlays.length > 0) {
      const cyphers = valuablePlays.map((play) => {
        let cypher = `
          MATCH (c:${this.ageToString(this.age)}CardInstance {name: $cardName, players: $players})-[:USED_IN]->(g:Game {gameId: $gameId})<-[:JOINS]-({playerId: $playerId})<-[:WONDER_FOR]-(w {name: $wonderName, gameId: $gameId})-[:SCORES]->(score:WonderScore)
        `;
        const params = {
          players: play.players,
          cardName: play.cardName,
          gameId: this.id,
          playerId: play.playerId,
          wonderName: play.wonderName,
        };
        if (!isNaN(play.cardValue)) {
          cypher = cypher + 'WITH toInteger(c.value) as coins, c, score WHERE coins IS NOT NULL MERGE (c)-[:PAYS {value: coins}]->(score) SET score.coins = score.coins + coins';
        } else if (coinsAndVP.test(play.cardValue)) {
          const [values, color] = play.cardValue.split(' ');
          const rate = parseInt(values.match(/\((?<rate>\d+)\)/).groups.rate);
          if (color === 'wonder') {
            // not a real color, rather the stages that are built
            cypher += ' WITH score, c, length([(w)-[:CHOOSES]->()-[:HAS_STAGE]->(stage)<-[:BUILDS]-() | stage]) * $rate AS coins MERGE (c)-[:PAYS {value: coins}]->(score) SET score.coins = score.coins + coins';
          } else {
            cypher += ' WITH score, c, length([(w)-[:PLAYS]->(card {color: $color}) | card]) * $rate AS coins MERGE (c)-[:PAYS {value: coins}]->(score) SET score.coins = score.coins + coins';
          }
          params.rate = rate;
          params.color = color;
        } else {
          const [direction, color, rate] = play.cardValue.split(' ');
          cypher += ` WITH score, c,
          (length([(w)-[:CLOCKWISE]->()-[:PLAYS]->(card {color: $color}) | card]) +
            length([(w)<-[:CLOCKWISE]-()-[:PLAYS]->(card {color: $color}) | card]) +
            length([(w)-[:PLAYS]->(card {color: $color}) | card])) * $rate AS coins
          MERGE (c)-[:PAYS {value: coins}]->(score) SET score.coins = score.coins + coins`;
          params.color = color;
          params.rate = parseInt(rate);
        }
        return {query: cypher, params};
      });
      for (let i = 0; i < cyphers.length; i++) {
        await this.runQuery(cyphers[i]);
      }
    }
  }

  async savePendingPlays() {
    let plays = [];
    let discards = [];
    let wonders = [];
    for (let [playerId, play] of Object.entries(this.pendingPlays)) {
      let wonderName = this.wonderSides[playerId].wonderName;
      if (play.type === 'play') {
        plays.push({playerId: playerId,
          wonderName: wonderName,
          cardName: play.card.name,
          cardColor: play.card.color,
          cardValue: play.card.value,
          players: play.card.players === 'guild' ? play.card.players : neo4j.int(play.card.players),
          cost: {
            self: neo4j.int(play.cost.self.cost),
            clockwise: neo4j.int(play.cost.clockwise.cost),
            counterClockwise: neo4j.int(play.cost.counterClockwise.cost)
          }
        });
      } else if (play.type === 'discard') {
        discards.push({playerId: playerId,
          wonderName: wonderName,
          cardName: play.card.name,
          players: play.card.players === 'guild' ? play.card.players : neo4j.int(play.card.players),
        });
      } else if (play.type === 'wonder') {
        wonders.push({playerId: playerId,
          wonderName: wonderName,
          cardName: play.card.name,
          players: play.card.players === 'guild' ? play.card.players : neo4j.int(play.card.players),
          cost: {
            self: neo4j.int(play.cost.self.cost),
            clockwise: neo4j.int(play.cost.clockwise.cost),
            counterClockwise: neo4j.int(play.cost.counterClockwise.cost)
          }
        });
      } else {
        this.emit('error', 'Unrecognized play type');
      }
    }
    await this.runQuery(this.cypherPlayCards(plays));
    await this.checkCoins(plays);
    await this.checkPoints(plays);
    await this.runQuery(this.cypherDiscard(discards));
    await this.runQuery(this.cypherBuildWonders(wonders));
  }

  async rotateHands() {
    await this.runQuery(this.cypherRotateHands());
  }

  async endAge() {
    await this.runQuery(this.cypherSettleMilitary());
    this.age++;
    this.round = 1;
    if (this.age < 4) {
      this.startRound();
    } else {
      this.endGame();
    }
  }

  tallyPoints() {
    // add tally of points
    Object.values(this.playersInfo).forEach((playerInfo) => {
      playerInfo.score = playerInfo.military +
          Math.floor(playerInfo.coins / 3) +
          playerInfo.wonderPoints +
          playerInfo.cultural +
          playerInfo.scienceScore +
          playerInfo.commercial +
          playerInfo.guilds;
    });
  }

  saveFinalScores() {
    this.runQuery(this.cypherSaveFinalScores());
  }

  sortScores(a, b) {
    // higher score is better (lower index in array)
    // remember --> if return is -1 is at lower index
    if (a.score > b.score) {
      return -1;
    } else if (a.score < b.score) {
      return 1;
    } else {
      // tie in scores, goes to whoever has more coins, else its a tie
      return b.coins - a.coins;
    }
  }

  async endGame() {
    let promises = this.endOfGamePointsItems()
        .map(item => this.cypherEndOfGamePoints(item))
        .map(queryInfo => this.runQuery(queryInfo));
    await Promise.all(promises);
    await this.getPlayersInfo();
    this.tallyPoints();
    this.saveFinalScores();
    const ranking = Object.values(this.playersInfo).sort(this.sortScores);
    // make sure players know if there is a tie -- flag the winners
    ranking.filter(playerInfo => playerInfo.score === ranking[0].score && playerInfo.coins === ranking[0].coins)
        .forEach(winner => winner.winner = true);
    // notify final score 
    this.broadcast({messageType: 'ranking', ranking});
  }

  checkEndOfRound() {
    if (Object.keys(this.pendingPlays).length === this.players.length)
      this.endRound();
  }

  handlePlayCard(player, card, cost) {
    // todo - ensure player can actually play the card
    this.pendingPlays[player.id] = {
      type: 'play',
      card: card,
      cost
    };
    this.checkEndOfRound();
  }

  // NOTE: this is a WIP method and not finished
  canPlayCard(player, card) {
    if (this.playersInfo[player.id].cardsPlayed != null && 
        this.playersInfo[player.id].cardsPlayed.map(card => card.name).indexOf(card.name) != -1) {
      return false;
    } else if (card.isFree || (card.cost == null)) {
      return true;
    // TODO: make this method cleaner... make a card class
    } else if (card.playOption == null) {
      return false;
    } else {
      let requirements = this.resourceObject(card.cost.split(''));
      let playerResources = this.resourceObject(this.getPlayerResources(player));
      let playedResources = [];
      Object.values(card.playOption).forEach(player => playedResources.push(...player.resource));
    }
  }

  resourceObject(resourceArray = []) {
    let resources = {};
    let ensureKey = (object, key) => object[key] = 0;
    resourceArray.forEach((resource) => {
      if (resource.includes('/')) {
        ensureKey(resources, resource);
        resources[resource]++;
      } else {
        ensureKey(resources, resource[0]);
        resources[resource[0]] += resource.length;
      }
    });
    return resources;
  }

  // return resources availble for player to use
  getPlayerResources(player) {
    let playerInfo = this.playersInfo[player.id];
    let resources = [];
    resources.push(playerInfo.wonderResource);
    resources.push(...playerInfo.stagesInfo
                        .filter(stage => stage.isBuilt && stage.isResource)
                        .map(stage => stage.resource));
    if (playerInfo.cardsPlayed != null) {
      resources.push(...playerInfo.cardsPlayed.filter(card => card.isResource).map(card => card.value));
    }
    return resources;
  }

  handleBuildWonder(player, card, cost) {
    // todo - ensure player can actually play the card
    this.pendingPlays[player.id] = {
      type: 'wonder',
      card: card,
      cost
    };
    this.checkEndOfRound();
  }

  canBuildWonder(player, card) {
  }

  handleDiscard(player, card) {
    // todo - ensure player can actually play the card
    this.pendingPlays[player.id] = {
      type: 'discard',
      card: card
    };
    this.checkEndOfRound();
  }

  // connect to database and run query
  // cypher is object with query and params
  // closes session and returns resp
  async runQuery(cypher) {
    if (cypher.query) {
      let session = driver.session();
      try {
        let resp = await session.run(cypher.query, cypher.params);
        session.close();
        return resp;
       } catch (error) {
          this.emit('error', error);
       };
    } else {
      this.emit('error', new Error('query not included with cypher object'));
    }
  }

  // functions returning params needed for database queries
  cypherSetupGame() {
    let params = {
      gameId: this.id,
      name: this.name,
      maxPlayers: neo4j.int(this.maxPlayers),
      gameType: this.gameType,
      creator: this.creator
    };
    let query = `
      // Create/find game node and count of current players
      MERGE (g:Game {gameId: $gameId}) 
        ON CREATE SET g.state = 'new',
          g.age = 1,
          g.round = 1,
          g.maxPlayers = $maxPlayers,
          g.gameType = $gameType,
          g.creator = $creator,
          g.name = $name,
          g.createdOn = datetime()
      WITH g
      OPTIONAL MATCH (g)<-[:JOINS]-(p)
      RETURN g.state AS state,
        g.maxPlayers AS maxPlayers,
        g.gameType AS gameType,
        g.creator AS creator,
        g.name AS name,
        g.age AS age,
        g.round AS round,
        count(p) AS currentPlayers
    `;

    return {params: params, query: query};
  }

  cypherSaveState() {
    let params = {
      gameId: this.id,
      state: this.state,
      round: neo4j.int(this.round),
      age: neo4j.int(this.age)
    };
    let query = `
      // Save state
      MATCH (g:Game {gameId: $gameId}) 
      SET g.state = $state,
        g.round = $round,
        g.age = $age
    `;

    return {params: params, query: query};
  }

  cypherGetPlayers() {
    let params = {
      gameId: this.id
    };
    let query = `
      // Get players currently in game
      MATCH (g:Game {gameId: $gameId}) 
      OPTIONAL MATCH (g)<-[:JOINS]-(p)
      RETURN p.playerId AS playerId,
        p.name AS name
    `;

    return {params: params, query: query};
  }

  cypherGetWonders() {
    let query = `
      // get all potential wonders
      MATCH (w:Wonder) RETURN w.name AS name
    `;
    return {query: query};
  }

  cypherSaveWonders(wonders) {
    let params = {
      gameId: this.id,
      wonders: wonders
    };
    let query = `
      // save the selected wonders for the game and create sides/stages
      MATCH (g:Game {gameId: $gameId})
      UNWIND $wonders AS wonder
      MATCH (w:Wonder {name: wonder})
      MERGE (wi:WonderInstance {name: wonder, gameId: $gameId})
      MERGE (wi)-[:SCORES]->(score:WonderScore)
        ON CREATE SET score.military = 0,
          score.coins = 3,
          score.cultural = 0,
          score.science = 0,
          score.guilds = 0,
          score.commercial = 0,
          score.wonderPoints = 0
      MERGE (wi)-[:INSTANCE_IN]->(g)
      MERGE (g)-[:PAYS {value: 3}]->(score)
      WITH wi, w
      MATCH (w)-[:HAS_SIDE]->(side)-[:HAS_STAGE]->(stage)
      MERGE (wi)-[:HAS_SIDE]->(sideIns:WonderSide {side: side.side})
      SET sideIns = side
      MERGE (sideIns)-[:HAS_STAGE]->(stageIns:WonderStage {stage: stage.stage})
      SET stageIns = stage
      WITH collect(distinct(wi)) AS instances
      UNWIND RANGE(0, size(instances) - 2) AS idx
      WITH instances, collect([idx, idx + 1]) + [[size(instances) - 1, 0]] AS pairs
      UNWIND pairs AS pair
      WITH instances[pair[0]] AS wi1, instances[pair[1]] AS wi2
      // clockwise means wi1 is clockwise of wi2 - if wi2 passes clockwise it goes to wi1
      MERGE (wi1)-[:CLOCKWISE]->(wi2)
    `;
    return {params: params, query: query};
  }

  cypherCountCards() {
    let params = {
      gameId: this.id
    };
    let query = `
      // return count of cards associated with the game
      MATCH (:Game {gameId: $gameId})<-[:USED_IN]-(c)
      RETURN count(*) AS cardsDealt
    `;
    return {params: params, query: query};
  }

  cypherGetCards(age) {
    let params = {
      players: neo4j.int(this.maxPlayers)
    };
    let query = `
      // get cards for use in game based on maxPlayers
      MATCH (c:${age}Card)
      WHERE c.players <= $players
      RETURN c.players AS players, c.name AS name
    `;
    return {params: params, query: query};
  }

  cypherGetGuilds() {
    let params = {
      players: 'guild'
    };
    let query = `
      // get guild cards
      MATCH (c:AgeThreeCard {players: $players})
      RETURN c.players AS players, c.name AS name
    `;
    return {params: params, query: query};
  }

  cypherSaveHands(age, hands) {
    let params = {
      hands: hands,
      gameId: this.id,
      age: age
    };
    let query = `
      // save the dealt out hands
      MATCH (g:Game {gameId: $gameId})
      MERGE (g)-[:HAS_AGE]->(age:Age {age: $age})
      WITH g, age
      UNWIND $hands AS hand
      MATCH (g)<-[:INSTANCE_IN]-(w {name: hand.wonder})
      MERGE (age)-[:HAS_HAND]->(h:Hand)-[:BELONGS_TO]->(w)
      WITH g, hand, h
      UNWIND hand.cards AS card
      MATCH (c:${age}Card {name: card.name, players: card.players})
      MERGE (ci:${age}CardInstance {name: card.name, players: card.players, gameId: $gameId})
      SET ci += c
      MERGE (ci)-[:IN_HAND]->(h)
      MERGE (ci)-[:USED_IN]->(g)
      WITH g, ci WHERE ci.freeFrom IS NOT NULL
      UNWIND split(ci.freeFrom, '~') AS freeName
      MATCH (g)<-[:USED_IN]-(free {name: freeName})
      MERGE (free)-[:FREE_BUILDS]->(ci)
    `;
    return {params: params, query: query};
  }

  cypherSavePlayers() {
    let params = {
      players: this.players.map((player) => { return {id: player.id}}),
      gameId: this.id
    };
    let query = `
      // add players to the game and assign wonders
      MATCH (g:Game {gameId: $gameId})
      UNWIND $players AS player
      MERGE (p:Player {playerId: player.id})
      MERGE (p)-[:JOINS]->(g)
      WITH g, collect(p) AS allP
      MATCH (g)<-[:INSTANCE_IN]-(w)
      WITH allP, collect(w) AS allW
      UNWIND range(0, size(allP) - 1) AS idx
      WITH allP[idx] AS p, allW[idx] AS w
      MERGE (p)<-[:WONDER_FOR]-(w)
    `;
    return {params: params, query: query};
  }

  cypherGetPlayOrder() {
    let params = {
      gameId: this.id,
      creator: this.creator
    };
    let query = `
      // get players ordered by clockwise distance from creator
      MATCH (g:Game {gameId: $gameId})<-[:JOINS]-(c:Player {playerId: $creator})
          <-[:WONDER_FOR]-(cw)-[:INSTANCE_IN]->(g)
      WITH g, c, cw
      MATCH (p)-[:JOINS]->(g), (p)<-[:WONDER_FOR]-(w)-[:INSTANCE_IN]->(g),
        // order by path means creator at first position, then player that creator is clockwise from
        path=(cw)-[:CLOCKWISE*0..7]->(w)
      WITH p, w, min(length(path)) as place
      RETURN {
        wonderName: w.name,
        playerName: p.name,
        playerId: p.playerId,
        place: place,
        wonderSide: head([(w)-[:CHOOSES]->(s) | s.side])
      } AS playerData ORDER BY place
    `;
    return {params, query};
  }

  cypherGetStartInfo() {
    let params = {
      gameId: this.id
    };
    let query = `
      // add players to the game and assign wonders
      MATCH (g:Game {gameId: $gameId})<-[:JOINS]-(p)<-[:WONDER_FOR]-(w)-[:INSTANCE_IN]->(g)
      RETURN p.playerId AS playerId,
        head([(rp)<-[:WONDER_FOR]-(rw)-[:CLOCKWISE]->(w)
            -[:CLOCKWISE]->(lw)-[:WONDER_FOR]->(lp) | {left: {name: lp.name, id: lp.playerId, resource: "", stage: 0, wonder: lw.name},
                right: {name: rp.name, id: rp.playerId, resource: "", stage: 0, wonder: rw.name}}]) AS neighbors
    `;
    return {params: params, query: query};
  }

  cypherGetWonderOptions() {
    let params = {
      gameId: this.id
    };
    let query = `
      // get information needed for players to choose wonder side
      MATCH (g:Game {gameId: $gameId})<-[:JOINS]-(p)<-[:WONDER_FOR]-(w)-[:HAS_SIDE]->(side)-[:HAS_STAGE]->(stage),
        (w)-[:INSTANCE_IN]->(g)
      WITH g, p, w, side,
        stage.stage AS sStage, stage.cost AS sCost, stage.resource AS sRes,
        stage.science AS sSci, stage.custom AS sCust, stage.points AS sPoints,
        stage.coins AS sCoins, stage.military AS sMil ORDER BY stage.stage
      WITH p.playerId AS playerId,
        p.name AS playerName,
        w.name AS wonderName,
        side.side AS wonderSide,
        side.resource AS wonderResource,
        collect({
          stage: sStage,
          cost: sCost,
          points: sPoints,
          resource: sRes,
          science: sSci,
          custom: sCust,
          coins: sCoins,
          military: sMil
        }) AS stagesInfo
        ORDER BY side.side
      RETURN playerId,
        playerName,
        wonderName,
        collect({
          side: wonderSide,
          resource: wonderResource,
          stages: stagesInfo
        }) AS wonderSides
    `;
    return {params: params, query: query};
  }

  cypherSaveWonderOptions(chosenSides) {
    let params = {
      gameId: this.id,
      chosenSides: chosenSides
    };
    let query = `
      // save chosen wonderside
      MATCH (g:Game {gameId: $gameId})
      UNWIND $chosenSides AS sideInfo
      MATCH (g)<-[:JOINS]-({playerId: sideInfo.playerId})<-[:WONDER_FOR]-(w {name: sideInfo.wonderName})-[:HAS_SIDE]->(s {side: sideInfo.side}),
        (w)-[:INSTANCE_IN]->(g)
      MERGE (w)-[:CHOOSES]->(s)
    `;
    return {params: params, query: query};
  }

  cypherGetPlayersInfo() {
    let params = {
      gameId: this.id
    };
    let query = `
      // get public information about all players
      MATCH (g:Game {gameId: $gameId})<-[:JOINS]-(p)<-[:WONDER_FOR]-(w)-[:SCORES]->(score),
        (g)<-[:INSTANCE_IN]-(w)-[:CHOOSES]->(side)-[:HAS_STAGE]->(stage)
      WITH g, p, w, score, side.side AS wSide, side.resource AS wRes,
        stage.stage AS sStage, stage.cost AS sCost, stage.resource AS sRes,
        stage.science AS sSci, stage.custom AS sCust, stage.points AS sPoints,
        stage.coins AS sCoins, stage.military AS sMil, stage.isResource AS sIsRes,
        CASE
          WHEN (stage)<-[:BUILDS]-() THEN true
          ELSE false
        END AS stageBuilt ORDER BY sStage
      WITH g, p, w, score, wSide, wRes,
        collect({
          stage: sStage,
          cost: sCost,
          points: sPoints,
          resource: sRes,
          science: sSci,
          custom: sCust,
          coins: sCoins,
          military: sMil,
          isBuilt: stageBuilt,
          isResource: sIsRes
        }) AS stagesInfo
      RETURN g.gameId AS gameId,
        p.playerId AS playerId,
        p.name AS playerName,
        w.name AS wonderName,
        wSide AS wonderSide,
        wRes AS wonderResource,
        score.coins AS coins,
        score.commercial AS commercial,
        score.guilds AS guilds,
        score.wonderPoints AS wonderPoints,
        score.military AS military,
        score.cultural AS cultural,
        [ (score)<-[sci:SCORES_SCIENCE]-() | sci.value ] AS scienceValues,
        [ (w)-[:CLOCKWISE]->()-[:WONDER_FOR]->(cp) | cp.playerId ][0] AS clockwisePlayer,
        [ (w)<-[:CLOCKWISE]-()-[:WONDER_FOR]->(cp) | cp.playerId ][0] AS counterClockwisePlayer,
        stagesInfo
    `;
    return {params: params, query: query};
  }

  cypherGetPlayedCards() {
    let params = {
      gameId: this.id
    };
    let query = `
      // get cards played by all players
      MATCH (g:Game {gameId: $gameId})<-[:JOINS]-(p)<-[:WONDER_FOR]-(w)-[:INSTANCE_IN]->(g),
        (w)-[:PLAYS]->(c)
      OPTIONAL MATCH (c)-[:FREE_BUILDS]->(free)
      WITH g, p, w, c,
        CASE
          WHEN free IS NULL THEN []
          ELSE collect(free.name)
        END AS freeBuilds
      RETURN g.gameId AS gameId,
        p.playerId AS playerId,
        p.name AS playerName,
        w.name AS wonderName,
        collect({
          name: c.name,
          color: c.color,
          type: c.type,
          value: c.value,
          cost: c.cost,
          isResource: c.isResource,
          freeBuilds: freeBuilds
        }) AS cards
    `;
    return {params: params, query: query};
  }

  cypherGetHandInfo() {
    let params = {
      gameId: this.id,
      age: this.ageToString(this.age)
    };
    let query = `
      // get private information about player's hands
      MATCH (a:Age {age: $age})<-[:HAS_AGE]-(g:Game {gameId: $gameId})<-[:JOINS]-(p)<-[:WONDER_FOR]-(w),
        (a)-[:HAS_HAND]->(hand)-[:BELONGS_TO]->(w)-[:INSTANCE_IN]->(g),
        (hand)<-[:IN_HAND]-(card)
      WITH g, p, w, hand, card,
        [(card)-[:FREE_BUILDS]->(free) | free {.name, .color, .value}] AS freeInfo,
        [(freeFrom)-[:FREE_BUILDS]->(card) | freeFrom.name] AS freeFrom
      RETURN g.gameId AS gameId,
        p.playerId AS playerId,
        collect(DISTINCT({
          name: card.name,
          color: card.color,
          value: card.value,
          cost: card.cost,
          freeBuilds: freeInfo,
          freeFrom: freeFrom,
          players: card.players,
          isFree: CASE
            WHEN (card)<-[:FREE_BUILDS]-()<-[:PLAYS]-(w) THEN true
            ELSE false
          END
        })) AS hand
    `;
    return {params: params, query: query};
  }

  cypherPlayCards(cards) {
    let stringAge = this.ageToString(this.age);
    let params = {
      gameId: this.id,
      cards: cards,
      age: stringAge
    };
    let query = `
      // save chosen plays
      MATCH (g:Game {gameId: $gameId})-[:HAS_AGE]->(a {age: $age})
      UNWIND $cards AS playInfo
      MATCH (g)<-[:JOINS]-({playerId: playInfo.playerId})<-[:WONDER_FOR]-(w {name: playInfo.wonderName}),
        (a)-[:HAS_HAND]->(hand)-[:BELONGS_TO]->(w),
        (hand)<-[ih:IN_HAND]-(card:${stringAge}CardInstance {players: playInfo.players, name: playInfo.cardName, gameId: $gameId}),
        (cScore)<-[:SCORES]-()<-[:CLOCKWISE]-(w)<-[:CLOCKWISE]-()-[:SCORES]->(ccScore),
        (w)-[:SCORES]->(myScore)
      MERGE (w)-[:PLAYS]->(card)
      DELETE ih
      // use foreach and case to figure out if need to pay out
      FOREACH (unusedVariable IN CASE WHEN playInfo.cost.self > 0 THEN [1] ELSE [] END | CREATE (myScore)-[:PAYS {value: playInfo.cost.self}]->(g) SET myScore.coins = myScore.coins - playInfo.cost.self)
      FOREACH (unusedVariable IN CASE WHEN playInfo.cost.clockwise > 0 THEN [1] ELSE [] END | CREATE (myScore)-[:PAYS {value: playInfo.cost.clockwise}]->(cScore) SET myScore.coins = myScore.coins - playInfo.cost.clockwise, cScore.coins = cScore.coins + playInfo.cost.clockwise)
      FOREACH (unusedVariable IN CASE WHEN playInfo.cost.counterClockwise > 0 THEN [1] ELSE [] END | CREATE (myScore)-[:PAYS {value: playInfo.cost.counterClockwise}]->(ccScore) SET myScore.coins = myScore.coins - playInfo.cost.counterClockwise, ccScore.coins = ccScore.coins + playInfo.cost.counterClockwise)
      FOREACH (unusedVariable IN CASE WHEN card.value IN ['@', '&', '#', '&/@/#'] THEN [1] ELSE [] END | CREATE (myScore)<-[:SCORES_SCIENCE {value: card.value}]-(card))
    `;
    return {params: params, query: query};
  }

  cypherBuildWonders(cards) {
    let stringAge = this.ageToString(this.age);
    let params = {
      gameId: this.id,
      cards: cards,
      age: stringAge
    };
    let query = `
      // save chosen wonder building
      MATCH (g:Game {gameId: $gameId})-[:HAS_AGE]->(a {age: $age})
      UNWIND $cards AS playInfo
      MATCH (g)<-[:JOINS]-({playerId: playInfo.playerId})<-[:WONDER_FOR]-(w {name: playInfo.wonderName})-[:CHOOSES]->()-[:HAS_STAGE]->(stage),
        (a)-[:HAS_HAND]->(hand)-[:BELONGS_TO]->(w)-[:INSTANCE_IN]->(g),
        (hand)<-[ih:IN_HAND]-(card:${stringAge}CardInstance {players: playInfo.players, name: playInfo.cardName, gameId: $gameId}),
        (cScore)<-[:SCORES]-()<-[:CLOCKWISE]-(w)<-[:CLOCKWISE]-()-[:SCORES]->(ccScore),
        (w)-[:SCORES]->(myScore)
      WHERE NOT (stage)<-[:BUILDS]-()
      WITH ih, stage, card, playInfo, myScore, g, cScore, ccScore ORDER BY stage.stage
      WITH ih, card, playInfo, myScore, g, cScore, ccScore, collect(stage) AS stages
      WITH ih, card, playInfo, myScore, g, cScore, ccScore, head(stages) AS stage
      MERGE (stage)<-[:BUILDS]-(card)
      DELETE ih
      // use foreach and case to figure out if need to pay out
      FOREACH (unusedVariable IN CASE WHEN playInfo.cost.self > 0 THEN [1] ELSE [] END | CREATE (myScore)-[:PAYS {value: playInfo.cost.self}]->(g) SET myScore.coins = myScore.coins - playInfo.cost.self)
      FOREACH (unusedVariable IN CASE WHEN playInfo.cost.clockwise > 0 THEN [1] ELSE [] END | CREATE (myScore)-[:PAYS {value: playInfo.cost.clockwise}]->(cScore) SET myScore.coins = myScore.coins - playInfo.cost.clockwise, cScore.coins = cScore.coins + playInfo.cost.clockwise)
      FOREACH (unusedVariable IN CASE WHEN playInfo.cost.counterClockwise > 0 THEN [1] ELSE [] END | CREATE (myScore)-[:PAYS {value: playInfo.cost.counterClockwise}]->(ccScore) SET myScore.coins = myScore.coins - playInfo.cost.counterClockwise, ccScore.coins = ccScore.coins + playInfo.cost.counterClockwise)
      FOREACH (unusedVariable IN CASE WHEN stage.coins IS NOT NULL THEN [1] ELSE [] END | CREATE (myScore)<-[:PAYS {value: stage.coins}]-(stage) SET myScore.coins = myScore.coins + stage.coins)
      FOREACH (unusedVariable IN CASE WHEN stage.points IS NOT NULL THEN [1] ELSE [] END | CREATE (myScore)<-[:SCORES_POINTS {value: toInteger(stage.points)}]-(stage) SET myScore.wonderPoints = myScore.wonderPoints + coalesce(toInteger(stage.points), 0))
      FOREACH (unusedVariable IN CASE WHEN stage.science IS NOT NULL THEN [1] ELSE [] END | CREATE (myScore)<-[:SCORES_SCIENCE {value: '&/@/#'}]-(stage))
    `;
    return {params: params, query: query};
  }

  cypherSettleMilitary() {
    let stringAge = this.ageToString(this.age);
    const milRate = this.age === 1 ? 1 : this.age === 2 ? 3 : 5;
    let params = {
      gameId: this.id,
      age: stringAge,
      milRate: neo4j.int(milRate)
    };
    let query = `
      // save chosen wonder building
      MATCH (g:Game {gameId: $gameId})-[:HAS_AGE]->(a {age: $age})
      MATCH (g)<-[:JOINS]-(p)<-[:WONDER_FOR]-(w),
        (w)-[:INSTANCE_IN]->(g),
        (cScore)<-[:SCORES]-(cw)<-[:CLOCKWISE]-(w)<-[:CLOCKWISE]-(ccw)-[:SCORES]->(ccScore),
        (w)-[:SCORES]->(myScore)
      WITH DISTINCT w, myScore, a, cw, cScore, ccw, ccScore,
        reduce(s = 0, mil IN [(w)-[:PLAYS]->(c {color: 'red'}) | c.value] | s + mil) + reduce(s = 0, mil in [(w)-[:CHOOSES]->()-[:HAS_STAGE]->(stage)<-[:BUILDS]-() WHERE stage.military IS NOT NULL | stage.military] | s + mil) AS myMil,
        reduce(s = 0, mil IN [(cw)-[:PLAYS]->(c {color: 'red'}) | c.value] | s + mil) + reduce(s = 0, mil in [(cw)-[:CHOOSES]->()-[:HAS_STAGE]->(stage)<-[:BUILDS]-() WHERE stage.military IS NOT NULL | stage.military] | s + mil) AS cMil,
        reduce(s = 0, mil IN [(ccw)-[:PLAYS]->(c {color: 'red'}) | c.value] | s + mil) + reduce(s = 0, mil in [(ccw)-[:CHOOSES]->()-[:HAS_STAGE]->(stage)<-[:BUILDS]-() WHERE stage.military IS NOT NULL | stage.military] | s + mil) AS ccMil
      FOREACH (unusedVariable IN CASE WHEN myMil > cMil THEN [1] ELSE [] END | CREATE (myScore)-[:DEFEATS {age: $age}]->(cScore) SET myScore.military = myScore.military + $milRate)
      FOREACH (unusedVariable IN CASE WHEN myMil > ccMil THEN [1] ELSE [] END | CREATE (myScore)-[:DEFEATS {age: $age}]->(ccScore) SET myScore.military = myScore.military + $milRate)
      FOREACH (unusedVariable IN CASE WHEN myMil < cMil THEN [1] ELSE [] END | SET myScore.military = myScore.military - 1)
      FOREACH (unusedVariable IN CASE WHEN myMil < ccMil THEN [1] ELSE [] END | SET myScore.military = myScore.military - 1)
    `;
    return {params: params, query: query};
  }


  cypherDiscard(cards) {
    let stringAge = this.ageToString(this.age);
    let params = {
      gameId: this.id,
      cards: cards,
      age: stringAge
    };
    let query = `
      // save chosen discards
      MATCH (g:Game {gameId: $gameId})-[:HAS_AGE]->(a {age: $age})
      UNWIND $cards AS playInfo
      MATCH (g)<-[:JOINS]-({playerId: playInfo.playerId})<-[:WONDER_FOR]-(w {name: playInfo.wonderName})-[:SCORES]->(score),
        (a)-[:HAS_HAND]->(hand)-[:BELONGS_TO]->(w),
        (hand)<-[ih:IN_HAND]-(card:${stringAge}CardInstance {players: playInfo.players, name: playInfo.cardName, gameId: $gameId})
      MERGE (w)-[:DISCARDS]->(card)
      DELETE ih
      CREATE (g)-[:PAYS {value: 3}]->(score)
      SET score.coins = score.coins + 3
    `;
    return {params: params, query: query};
  }

  cypherRotateHands() {
    let stringAge = this.ageToString(this.age);
    let params = {
      gameId: this.id,
      age: stringAge
    };
    let query = `
      // rotate hands based on age
      MATCH (:Game {gameId: $gameId})-[:HAS_AGE]->({age: $age})-[:HAS_HAND]->(hand)-[bt:BELONGS_TO]->(w),
        // in age 2 cards go clockwise, so next wonder is the one with a :CLOCKWISE pointing to current wonder
        (w)${this.age === 2 ? '<' : ''}-[:CLOCKWISE]-${this.age === 2 ? '' : '>'}(nextW)
      DELETE bt
      MERGE (hand)-[:BELONGS_TO]->(nextW)
    `;
    return {query, params};
  }

  /**
   * Get array of items that produce points at end of round
   * @return {Object[]} items - items for calculating end of game points
   * @return {string} items[].cardName
   * @return {string} items[].cypherCalculatePoints
   * @return {string} items[].pointsType
   **/
  endOfGamePointsItems() {
    const items = [
      {
        cardName: 'Workers Guild',
        cypherCalculatePoints: `MATCH (wonder)-[:CLOCKWISE]-(ow)-[:PLAYS]->(c {color: 'brown'})
                        WITH wonder, card, myScore, count(c) AS points`,
        pointsType: 'guilds',
      },
      {
        cardName: 'Craftsmens Guild',
        cypherCalculatePoints: `MATCH (wonder)-[:CLOCKWISE]-(ow)-[:PLAYS]->(c {color: 'gray'})
                        WITH wonder, card, myScore, count(c) * 2 AS points`,
        pointsType: 'guilds',
      },
      {
        cardName: 'Traders Guild',
        cypherCalculatePoints: `MATCH (wonder)-[:CLOCKWISE]-(ow)-[:PLAYS]->(c {color: 'yellow'})
                        WITH wonder, card, myScore, count(c) AS points`,
        pointsType: 'guilds',
      },
      {
        cardName: 'Philosophers Guild',
        cypherCalculatePoints: `MATCH (wonder)-[:CLOCKWISE]-(ow)-[:PLAYS]->(c {color: 'green'})
                        WITH wonder, card, myScore, count(c) AS points`,
        pointsType: 'guilds',
      },
      {
        cardName: 'Spies Guild',
        cypherCalculatePoints: `MATCH (wonder)-[:CLOCKWISE]-(ow)-[:PLAYS]->(c {color: 'red'})
                        WITH wonder, card, myScore, count(c) AS points`,
        pointsType: 'guilds',
      },
      {
        cardName: 'Strategists Guild',
        cypherCalculatePoints: `MATCH (wonder)-[:CLOCKWISE]-(ow)-[:SCORES]->()<-[:DEFEATS]-(c)
                        WITH wonder, card, myScore, count(c) AS points`,
        pointsType: 'guilds',
      },
      {
        cardName: 'Shipowners Guild',
        cypherCalculatePoints: `MATCH (wonder)-[:PLAYS]->(c)
                        WHERE c.color IN ['brown', 'gray', 'purple']
                        WITH wonder, card, myScore, count(c) AS points`,
        pointsType: 'guilds',
      },
      {
        cardName: 'Magistrates Guild',
        cypherCalculatePoints: `MATCH (wonder)-[:CLOCKWISE]-(ow)-[:PLAYS]->(c {color: 'blue'})
                        WITH wonder, card, myScore, count(c) AS points`,
        pointsType: 'guilds',
      },
      {
        cardName: 'Builders Guild',
        cypherCalculatePoints: `MATCH (wonder)-[:CLOCKWISE*0..1]-(ow)-[:CHOOSES]->()-[:HAS_STAGE]->()<-[:BUILDS]-(c)
                        WITH wonder, card, myScore, count(c) AS points`,
        pointsType: 'guilds',
      },
      {
        cardName: 'Haven',
        cypherCalculatePoints: `MATCH (wonder)-[:PLAYS]->(c {color: 'brown'})
                        WITH wonder, card, myScore, count(c) AS points`,
        pointsType: 'commercial',
      },
      {
        cardName: 'Chamber of Commerce',
        cypherCalculatePoints: `MATCH (wonder)-[:PLAYS]->(c {color: 'gray'})
                        WITH wonder, card, myScore, count(c) * 2 AS points`,
        pointsType: 'commercial',
      },
      {
        cardName: 'Lighthouse',
        cypherCalculatePoints: `MATCH (wonder)-[:PLAYS]->(c {color: 'yellow'})
                        WITH wonder, card, myScore, count(c) AS points`,
        pointsType: 'commercial',
      },
      {
        cardName: 'Arena',
        cypherCalculatePoints: `MATCH (wonder)-[:CHOOSES]->()-[:HAS_STAGE]->()<-[:BUILDS]-(c)
                        WITH wonder, card, myScore, count(c) AS points`,
        pointsType: 'commercial',
      },
    ];
    return items;
  }

  /**
   * Award points at end of game for applicable cards
   * @param {Object} item - end game item
   * @param {string} item.cardName - name of card that awards points
   * @param {string} item.cypherCalculatePoints - cypher snippet that uses wonder alias and rules of card
   *                    to end up with an alias points (keeps alias of card and myScore in scope)
   * @param {string} item.pointsType - key on :WonderScore to save points to (guilds or commercial)
   **/
  cypherEndOfGamePoints({cardName, cypherCalculatePoints, pointsType}) {
    const params = {
      gameId: this.id,
      cardName
    };
    const query = `
      // award points for cards at end of game
      MATCH (:Game {gameId: $gameId})<-[:USED_IN]-(card {name: $cardName})<-[:PLAYS]-(wonder)-[:SCORES]->(myScore)
      WITH card, wonder, myScore
      ${cypherCalculatePoints}
      MERGE (card)-[:SCORES_POINTS {value: points}]->(myScore)
        ON CREATE SET myScore.${pointsType} = coalesce(myScore.${pointsType}, 0) + points
    `;
    return {query, params};
  }

  cypherSaveFinalScores() {
    const params = {
      gameId: this.id,
      playersInfo: Object.values(this.playersInfo),
    };
    const query = `
      // save final scores and winner
      UNWIND $playersInfo AS playerInfo
      MATCH (g:Game {gameId: $gameId})<-[:JOINS]-(p {playerId: playerInfo.playerId})<-[:WONDER_FOR]-(w),
        (myScore)<-[:SCORES]-(w)-[:INSTANCE_IN]->(g)
      SET myScore.score = playerInfo.score,
        myScore.scienceScore = playerInfo.scienceScore
      WITH g, myScore, p ORDER BY myScore.score DESC limit 1
      MERGE (p)-[:WINS]->(g)
    `;
    return {query, params};
  }
}

module.exports = Game;
