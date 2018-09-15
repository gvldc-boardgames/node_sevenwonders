"use strict";
const neo4j = require('neo4j-driver').v1;
const EventEmitter = require('events');
const cardHelper = require('./../../helpers/card_helper');

const driver = neo4j.driver('bolt://localhost', neo4j.auth.basic('neo4j','BoardGames'));

class Game extends EventEmitter {
  constructor(options = {}) {
    super();
    this.creator = options.creator;
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
    this.playerInfo = {};
    this.playerHands = {};
    this.setListeners();
    this.readyPromise = this.checkState();
  }

  setListeners() {
    this.on('error', function(err) {
      console.log('error in game!', err, this);
    }).on('exit', function(data) {
      driver.close();
    });
  }

  setPlayerListeners(player) {
    // set up variables to use for listeners bound to "this" so they can be removed later
    // and still have proper scope
    const handlePlayCard = (player, card) => this.handlePlayCard(player, card);
    const handleBuildWonder = (player, card) => this.handleBuildWonder(player, card);
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

  async checkState() {
    let cypher = this.cypherSetupGame();
    let resp = await this.runQuery(cypher);
    let gameInfo = resp.records[0];
    if (gameInfo && gameInfo.get('gameType') === this.gameType) {
      if (gameInfo.get('state') === 'new') {
        this.maxPlayers = gameInfo.get('maxPlayers').toNumber();
        if (gameInfo.get('currentPlayers') > 0)
          await this.getPlayers();
        this.age = gameInfo.get('age').toNumber();
        this.round = gameInfo.get('round').toNumber();
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
        this.players.push(player);
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
    let resp = await this.runQuery(this.cypherGetWonderOptions());
    let wonderOptions = [];
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
      let ages = [];
      ages.push(this.dealAge('AgeOne'));
      ages.push(this.dealAge('AgeTwo'));
      ages.push(this.dealAge('AgeThree'));
      await Promise.all(ages);
    }
  }

  async cardsDealt() {
    let result = await this.runQuery(this.cypherCountCards());
    return result.records[0].get('cardsDealt').toNumber() != 0;
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
    console.log('set side', player.id, wonderSide);
    if (this.wonderSides[player.id] === null) {
      if (this.wonderOptions.filter((option) => {
        option.playerId === player.id && option.wonderName === wonderSide.wonderName
      }).length > 0) {
        // player can actually choose this wonder
        this.wonderSides[player.id] = {
          playerId: player.id,
          wonderName: wonderSide.wonderName,
          side: wonderSide.side
        };
      } else {
        // player tried to play a wonder he doesn't have!
      }
    } else {
      // player has already chosen a side
    }
    // check if all wonders played
    if (Object.keys(this.wonderSides).length === this.maxPlayers) {
      await this.runQuery(this.cypherSaveWonderOptions);
      await this.cardPromise;
      // start round
    }
  }

  handlePlayCard(player, card) {
    console.log('handle play card', player.id, card);
  }

  handleBuildWonder(player, card) {
    console.log('handle build wonder', player.id, card);
  }

  handleDiscard(player, card) {
    console.log('handle discad', player.id, card);
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
          g.name = $name
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
      state: this.state
    };
    let query = `
      // Save state
      MATCH (g:Game {gameId: $gameId}) 
      SET g.state = $state
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
          score.wonder = 0,
          score.science = 0,
          score.guilds = 0,
          score.buildings = 0,
          score.other = 0
      MERGE (wi)-[:INSTANCE_IN]->(g)
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
      MATCH (card:${age}Card {name: card.name, players: card.players})
      MERGE (ci:${age}CardInstance {name: card.name, players: card.players, gameId: $gameId})
      SET ci += card
      MERGE (ci)-[:IN_HAND]->(h)
      MERGE (ci)-[:USED_IN]->(g)
      WITH g, ci WHERE ci.freeFrom IS NOT NULL
      MATCH (g)<-[:USED_IN]-(free {name: ci.freeFrom})
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

  cypherGetWonderOptions() {
    let params = {
      gameId: this.id
    };
    let query = `
      // get information needed for players to choose wonder side
      MATCH (g:Game {gameId: $gameId})<-[:JOINS]-(p)<-[:WONDER_FOR]-(w)-[:HAS_SIDE]->(side)-[:HAS_STAGE]->(stage)
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
      MATCH (g)<-[:JOINS]-({playerId: sideInfo.playerId})<-[:WONDER_FOR]-(w {name: sideInfo.wonderName})-[:HAS_SIDE]->(s {side: sideInfo.side})
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
      MATCH (g:Game {gameId: $gameId})<-[:JOINS]-(p)<-[:WONDER_FOR]-(w)-[:SCORES]->(score)
      MATCH (w)-[:CHOOSES]->(side)-[:HAS_STAGE]->(stage)
      WITH g, p, w, score, side.side AS wSide, side.resource AS wRes,
        stage.stage AS sStage, stage.cost AS sCost, stage.resource AS sRes,
        stage.science AS sSci, stage.custom AS sCust, s.points AS sPoints,
        stage.coins AS sCoins, stage.military AS sMil,
        CASE
          WHEN (stage)<-[:BUILDS]-() THEN true
          ELSE false
        END AS stageBuilt ORDER BY wStage
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
          built: stageBuilt
        }) AS stagesInfo
      OPTIONAL MATCH (w)-[:PLAYS]->(c)
      OPTIONAL MATCH (c)-[:FREE_BUILDS]->(free)
      WITH g, p, w, score, wSide, wRes, stagesInfo, c, collect(free.name) AS freeBuilds
      RETURN g.gameId AS gameId,
        p.playerId AS playerId,
        p.name AS playerName,
        w.name AS wonderName,
        wSide AS wonderSide,
        wRes AS wonderResource,
        score.coins AS coins,
        score.military AS military,
        stagesInfo,
        collect({
          name: c.name,
          color: c.color,
          value: c.value,
          cost: c.cost,
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
        (a)-[:HAS_HAND]->(hand)-[:BELONGS_TO]->(w),
        (hand)<-[:IN_HAND]-(card)
      OPTIONAL MATCH (card)-[:FREE_BUILDS]->(free)
      WITH g, p, w, hand, card,
        collect({
          name: free.name,
          color: free.color,
          value: free.value
        }) AS freeInfo
      RETURN g.gameId AS gameId,
        p.playerId AS playerId,
        collect({
          name: card.name,
          color: card.color,
          value: card.value,
          cost: card.cost,
          freeBuilds: freeInfo,
          isFree: CASE
            WHEN (card)<-[:FREE_BUILDS]-()<-[:PLAYS]-(w) THEN true
            ELSE false
          END
        }) AS hand
    `;
    return {params: params, query: query};
  }

  cypherPlayCards(cards) {
    let stringAge = this.ageToString(this.age);
    let params = {
      gameId: this.id,
      chosenSides: chosenSides,
      age: stringAge
    };
    let query = `
      // save chosen plays
      MATCH (g:Game {gameId: $gameId})-[:HAS_AGE]->(a {age: $age})
      UNWIND $cards AS playInfo
      MATCH (g)<-[:JOINS]-({playerId: playInfo.playerId})<-[:WONDER_FOR]-(w {name: playInfo.wonderName}),
        (a)-[:HAS_HAND]->(hand)-[:BELONGS_TO]->(w),
        (hand)<-[ih:IN_HAND]-(card:${stringAge}CardInstance {players: playInfo.players, name: playInfo.cardName, gameId: $gameId})
      MERGE (w)-[:PLAYS]->(card)
      DELETE ih
    `;
    return {params: params, query: query};
  }

  cypherBuildWonders(cards) {
    let stringAge = this.ageToString(this.age);
    let params = {
      gameId: this.id,
      chosenSides: chosenSides,
      age: stringAge
    };
    let query = `
      // save chosen wonder building
      MATCH (g:Game {gameId: $gameId})-[:HAS_AGE]->(a {age: $age})
      UNWIND $cards AS playInfo
      MATCH (g)<-[:JOINS]-({playerId: playInfo.playerId})<-[:WONDER_FOR]-(w {name: playInfo.wonderName})-[:CHOOSES]->()-[:HAS_STAGE]->(stage {stage: $playInfo.stage}),
        (a)-[:HAS_HAND]->(hand)-[:BELONGS_TO]->(w),
        (hand)<-[ih:IN_HAND]-(card:${stringAge}CardInstance {players: playInfo.players, name: playInfo.cardName, gameId: $gameId})
      MERGE (stage)<-[:BUILDS]-(card)
      DELETE ih
    `;
    return {params: params, query: query};
  }

  cypherDiscard(cards) {
    let stringAge = this.ageToString(this.age);
    let params = {
      gameId: this.id,
      chosenSides: chosenSides,
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
      SET score.coins = score.coins + 3
    `;
    return {params: params, query: query};
  }
}

module.exports = Game;
