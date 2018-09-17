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
