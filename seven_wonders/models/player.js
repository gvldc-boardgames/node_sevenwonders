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
  }

  async login() {
    let resp = await this.runQuery(this.cypherLogin());
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
