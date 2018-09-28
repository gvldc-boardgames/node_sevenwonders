"use strict";
const neo4j = require('neo4j-driver').v1;
const EventEmitter = require('events');

const driver = neo4j.driver('bolt://localhost', neo4j.auth.basic('neo4j','BoardGames'));

class Player extends EventEmitter {
  constructor(options = {}) {
    super();
    this.name = options.name;
    this.id = options.id || `player-${Date.now()}`;
    this.readyPromise = this.login();
    this.once('wonderOption', this.receiveWonderOption);
    this.receiveHand = this.receiveHand.bind(this);
    this.receivePlayersInfo = this.receivePlayersInfo.bind(this);
    this.on('hand', this.receiveHand);
    this.on('playersInfo', this.receivePlayersInfo);
  }

  async login() {
    let resp = await this.runQuery(this.cypherLogin());
  }

  receiveWonderOption(wonderOption) {
    this.wonderOption = wonderOption;
  }

  /**
   * Alert listeners on chosen side
   *
   * @param {object} wonderSide - information about chosen side
   * @property {string} wonderSide.wonderName - name of wonder side is for
   * @property {string} wonderSide.side - a/b, which side is chosen
   */
  chooseWonderSide(wonderSide) {
    this.emit('wonderSideChosen', this, wonderSide);
  }

  receiveHand(hand) {
    this.hand = hand;
  }

  receivePlayersInfo(playersInfo) {
    this.playersInfo = playersInfo;
  }

  playCard(card) {
    this.emit('playCard', this, card);
  }

  getCombos(card) {
    if (this.playersInfo[this.id].cardsPlayed != null && 
        this.playersInfo[this.id].cardsPlayed.map(card => card.name).indexOf(card.name) != -1) {
      card.combos = [];
      return false;
    } else if (card.isFree || (card.cost == null)) {
      card.combos = [{clockwise: {resources: [], cost: 0}, counterClockwise: {resources: [], cost: 0}}];
      return true;
    } else {
      let requirements = this.resourceObject(card.cost.split(''));
      let playerResources = this.getMyResources();
      let neighborsResources = this.getNeighborsResource();
      Object.keys(requirements).forEach(function(key) {
        if (playerResources[key]) {
          requirements[key] -= playerResources[key];
          if (requirements[key] <= 0) {
            delete requirements[key];
          }
        }
      });
      if (Object.keys(requirements).length === 0) {
        card.combos = [{clockwise: {resources: [], cost: 0}, counterClockwise: {resources: [], cost: 0}}];
        return true;
      }
      card.combos = [];
      return false;
    }
  }

  resourceObject(resourceArray = []) {
    let resources = {withOptions: []};
    let ensureKey = (object, key) => object[key] = 0;
    resourceArray.forEach((resource) => {
      if (resource.includes('/')) {
        resources.withOptions.push(resource);
      } else {
        ensureKey(resources, resource[0]);
        resources[resource[0]] += resource.length;
      }
    });
    return resources;
  }

  // return resources availble for player to use
  getMyResources() {
    let playerInfo = this.playersInfo[this.id];
    let resources = [];
    resources.push(playerInfo.wonderResource);
    resources.push(...playerInfo.stagesInfo
                        .filter(stage => stage.isBuilt && stage.isResource)
                        .map(stage => stage.resource));
    if (playerInfo.cardsPlayed != null) {
      resources.push(...playerInfo.cardsPlayed.filter(card => card.isResource).map(card => card.value));
    }
    return this.resourceObject(resources);
  }

  getNeighborsResource() {
    let neighbors = {
      clockwise: this.getNeighborResource(this.playersInfo[this.id].clockwisePlayer),
      counterClockwise: this.getNeighborResource(this.playersInfo[this.id].counterClockwisePlayer)
    };
    return neighbors;
  }

  getNeighborResource(playerId) {
    let playerInfo = this.playersInfo[playerId];
    let resources = [];
    resources.push(playerInfo.wonderResource);
    if (playerInfo.cardsPlayed != null) {
      resources.push(...playerInfo.cardsPlayed.filter(card => card.isResource && ['brown', 'grey'].indexOf(card.color) > -1)
                                              .map(card => card.value));
    }
    return this.resourceObject(resources);
  }

  discard(card) {
    this.emit('discard', this, card);
  }

  buildWonder(card) {
    this.emit('buildWonder', this, card);
  }

  // connect to database and run query
  // cypher is object with query and params
  // closes session and returns resp
  async runQuery(cypher) {
    if (cypher.query) {
      let params = cypher.params || {playerId: this.id, playerName: this.name};
      let session = driver.session();
      try {
        let resp = await session.run(cypher.query, params);
        session.close();
        return resp;
       } catch (error) {
          this.emit('error', error);
       };
    } else {
      this.emit('error', new Error('query not included with cypher object'));
    }
  }

  cypherLogin() {
    let query = `
      // Ensure player exists
      MERGE (p:Player {playerId: $playerId})
      SET p.name = $playerName
    `;
    return {query: query};
  }
}

module.exports = Player;
