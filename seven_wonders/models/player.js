"use strict";
const neo4j = require('neo4j-driver').v1;
const EventEmitter = require('events');

const driver = neo4j.driver(process.env.NEO4J_BOLT,
    neo4j.auth.basic('neo4j','BoardGames'),
    {disableLosslessIntegers: true});

class Player extends EventEmitter {
  constructor(options = {}) {
    super();
    this.name = options.name;
    this.ws = options.ws;
    this.canPlay = true;
    this.id = options.id || `player-${Date.now()}`;
    this.readyPromise = this.login();
    this.once('wonderOption', this.receiveWonderOption);
    this.receiveHand = this.receiveHand.bind(this);
    this.receivePlayersInfo = this.receivePlayersInfo.bind(this);
    this.handleSocketMessage = this.handleSocketMessage.bind(this);
    this.on('hand', this.receiveHand);
    this.on('playersInfo', this.receivePlayersInfo);
    if (this.ws) {
      this.ws.on('message', this.handleSocketMessage);
    }
  }

  async login() {
    let resp = await this.runQuery(this.cypherLogin());
  }

  notify(data) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(data));
    }
  }

  receiveWonderOption(wonderOption) {
    this.wonderOption = wonderOption;
    this.notify({wonderOption, messageType: 'wonderOption'});
  }

  handleSocketMessage(message) {
    try {
      let parsed = JSON.parse(message);
      console.log('message received', parsed);
      if (parsed.messageType === 'wonderSide') {
        this.chooseWonderSide(parsed);
      } else if (parsed.messageType === 'playCard') {
        this.playCard(parsed);
      } else if (parsed.messageType === 'discardCard') {
        this.discardCard(parsed.card);
      } else if (parsed.messageType === 'buildWonder') {
        this.buildWonder(parsed);
      }
    } catch {
      this.notify({messageType: 'parseError', errorMessage: 'failed to parse'});
    }
  }

  /**
   * Alert listeners on chosen side
   *
   * @param {object} wonderSide - information about chosen side
   * @property {string} wonderSide.wonderName - name of wonder side is for
   * @property {string} wonderSide.side - a/b, which side is chosen
   */
  chooseWonderSide(wonderSide) {
    if (this.wonder == null && wonderSide.wonderName === this.wonderOption.wonderName) {
      console.log('about to emit wonder side chosen', wonderSide);
      this.wonder = {wonderName: wonderSide.wonderName, ...this.wonderOption.wonderSides.filter(s => s.side === wonderSide.side)[0]};
      this.emit('wonderSideChosen', this, wonderSide);
    }
  }

  receiveHand(hand) {
    this.hand = hand;
    this.canPlay = true;
    this.notify({hand: hand, messageType: 'hand'});
    hand.forEach(card => setImmediate(() => {
      this.getCombos(card);
      this.notify({messageType: 'playCombos', card});
    }));
    this.getWonderCombos();
  }

  getWonderCombos() {
    if (this.wonder == null) {
      return;
    } else {
      const nextStage = this.wonder.stages.filter(s => !s.isBuilt)[0];
      if (nextStage == null) {
        this.notify({messageType: 'wonderCombos', combos: []});
      } else {
        const requirements = this.resourceObject(nextStage.cost.split(''));
        const playerResources = this.getMyResources();
        Object.keys(requirements).filter(key => key.length !== 1)
            .forEach(key => delete requirements[key]);
        const combos = this.getAllCombos(requirements, playerResources);
        this.notify({messageType: 'wonderCombos', combos});
      }
    }
  }

  resourceName(resourceKey) {
    let resourceMap = {
      L: 'linen',
      G: 'glass',
      P: 'paper',
      S: 'stone',
      W: 'wood',
      O: 'ore',
      C: 'clay'
    }
    return resourceMap[resourceKey];
  }

  receivePlayersInfo(playersInfo) {
    // legacy hack
    if (this.playersInfo == null) {
      let leftInfo = playersInfo[playersInfo[this.id].clockwisePlayer];
      let rightInfo = playersInfo[playersInfo[this.id].counterClockwisePlayer];
      this.notify({
        messageType: 'neighborwonders',
        left: {wonder: leftInfo.wonderName,
            resource: this.resourceName(leftInfo.wonderResource)},
        right: {wonder: rightInfo.wonderName,
            resource: this.resourceName(rightInfo.wonderResource)}
      });
    }
    this.playersInfo = playersInfo;
    this.notify({
      messageType: 'playersInfo',
      playersInfo
    });
  }

  playCard({card, clockwise, counterClockwise, self}) {
    if (this.canPlay) {
      this.canPlay = false;
      card = this.hand.filter(c => c.name === card.name && c.players === card.players)[0];
      if (card != null)
        this.emit('playCard', this, card, {clockwise, counterClockwise, self});
    }
  }

  getCombos(card) {
    if (this.playersInfo[this.id].cardsPlayed != null && 
        this.playersInfo[this.id].cardsPlayed.map(card => card.name).indexOf(card.name) != -1) {
      card.playCombos = [];
      return false;
    } else if (card.isFree || (card.cost == null)) {
      card.playCombos = [
        {
          clockwise: {resources: [], cost: 0},
          counterClockwise: {resources: [], cost: 0},
          self: {resources: [], cost: 0}
        }
      ];
      return true;
    } else if (!isNaN(card.cost)) {
      // TODO make sure can pay
      if (parseInt(card.cost) <= this.playersInfo[this.id].coins) {
        card.playCombos = [
          {
            clockwise: {resources: [], cost: 0},
            counterClockwise: {resources: [], cost: 0},
            self: {resources: [], cost: parseInt(card.cost)}
          }
        ];
        return true;
      } else {
        card.playCombos = [];
        return false;
      }
    } else {
      let requirements = this.resourceObject(card.cost.split(''));
      Object.keys(requirements).filter(key => key.length !== 1)
          .forEach(key => delete requirements[key]);
      let playerResources = this.getMyResources();
      card.playCombos = this.getAllCombos(requirements, playerResources);
    }
  }

  getAllCombos(requirements, resources) {
    requirements = this.checkResources(requirements, resources);
    if (Object.keys(requirements).length === 0) {
      return [
        {
          clockwise: {resources: [], cost: 0},
          counterClockwise: {resources: [], cost: 0},
          self: {resources: [], cost: 0}
        }
      ];
    } else {
      let usableOptions = resources.withOptions.filter(options => options.some(opt => requirements[opt]));
      ({requirements, usableOptions} = this.checkOptionalResources(requirements, usableOptions));
      if (Object.keys(requirements).length === 0) {
        return [
          {
            clockwise: {resources: [], cost: 0},
            counterClockwise: {resources: [], cost: 0},
            self: {resources: [], cost: 0}
          }
        ];
      } else {
        let keySet = new Set();
        let combos = this.recursiveComboCheck(requirements, usableOptions);
        let comboCost = (combo) => Object.values(combo)
            .reduce((acc, val) => { return acc + val.cost }, 0); 
        let uniqCombos = combos.filter(combo => {
          let key = JSON.stringify(combo);
          return !keySet.has(key) && keySet.add(key);
        });
        return uniqCombos.sort((a,b) => comboCost(a) - comboCost(b));
      }
    }
    return [];
  }

  recursiveComboCheck(requirements, usableOptions) {
    usableOptions = [...usableOptions];
    requirements = {...requirements};
    if (usableOptions.length > 0) {
      let option = usableOptions.pop();
      let combos = [];
      option.forEach((resource) => {
        if (requirements[resource]) {
          let tempReq = {...requirements};
          tempReq[resource] -= 1;
          if (tempReq[resource] <= 0) {
            delete tempReq[resource];
          }
          ({requirements: tempReq, usableOptions} = this.checkOptionalResources(requirements, usableOptions));
          combos.push(...this.recursiveComboCheck(tempReq, usableOptions));
        }
      });
      return combos;
    } else {
      let neighborsResources = this.getNeighborsResource(requirements);
      return this.recursiveResourceBuy(requirements, neighborsResources);  
    }
  }

  applyNeighborOption(requirements, resource, resources) {
    requirements = {...requirements}
    if (resources[resource] == null) {
      resources[resource] = 1;
    } else {
      resources[resource]++;
    }
    let optionalUse = this.checkOptionalResources(requirements, resources.withOptions);
    requirements = optionalUse.requirements;
    resources.withOptions = optionalUse.usableOptions
      .filter(options => options.some(opt => requirements[opt]));
    optionalUse.usedOptions.forEach(function(resource) {
      if (resources[resource] == null) {
        resources[resource] = 1;
      } else {
        resources[resource] += 1;
      }
    });
    return resources;
  }

  recursiveResourceBuy(requirements, buyable) {
    requirements = {...requirements};
    buyable = {...buyable};
    if (buyable.clockwise.withOptions.length > 0) {
      let resourceOption = buyable.clockwise.withOptions.pop();
      for (let i = 0; i < resourceOption.length; i++) {
        let res = resourceOption[i];
        if (requirements[res]) {
          buyable.clockwise = 
              this.applyNeighborOption(requirements, res, buyable.clockwise);
          return this.recursiveResourceBuy(requirements, buyable);
        }
      }
    } else if (buyable.counterClockwise.withOptions.length > 0) {
      let resourceOption = buyable.counterClockwise.withOptions.pop();
      for (let i = 0; i < resourceOption.length; i++) {
        let res = resourceOption[i];
        if (requirements[res]) {
          buyable.counterClockwise = this.applyNeighborOption(
              requirements,
              res,
              buyable.counterClockwise
          );
          return this.recursiveResourceBuy(requirements, buyable);
        }
      }
    } else {
      let rates = this.getRates();
      let summaryFunction = function(resource) {
        let defaultToZero = (val) => val == null ? 0 : val;
        let clockwiseResource = defaultToZero(buyable.clockwise[resource]);
        let counterResource = defaultToZero(buyable.counterClockwise[resource]);
        let requiredCount = defaultToZero(requirements[resource]);
        return {
          resource,
          clockwiseResource,
          counterResource,
          requiredCount
        };
      };
      let reqSummary = Object.keys(requirements).map(summaryFunction);
      // check if required resource is impossible to buy
      if (reqSummary.some((s) => {
            return s.clockwiseResource +
                s.counterResource < s.requiredCount;
          })) {
        return [];
      }
      let allCombos = reqSummary.map(req => this.costToBuy(req, rates));
      while (allCombos.length > 1) { 
        let c1 = allCombos.shift();
        let c2 = allCombos.shift();
        let newC = [];
        for (let i = 0; i < c1.length; i++){
          for (let j = 0; j < c2.length; j++){
            newC.push({
              self: {
                count: c1[i].self.count + c2[j].self.count,
                cost: c1[i].self.cost + c2[j].self.cost
              },
              clockwise: {
                count: c1[i].clockwise.count + c2[j].clockwise.count,
                cost: c1[i].clockwise.cost + c2[j].clockwise.cost
              },
              counterClockwise: {
                count: c1[i].counterClockwise.count +
                    c2[j].counterClockwise.count,
                cost: c1[i].counterClockwise.cost + c2[j].counterClockwise.cost
              }
            });
          }
        }
        allCombos.unshift(newC);
      }
      return allCombos[0].filter((combo) => {
        return Object.values(combo).reduce((acc, obj) => {
          return acc + obj.cost;
        }, 0) <= this.playersInfo[this.id].coins;
      });
    }
  }
  
  /**
   * Pick best optional resource based on summaries and rates
   * @param {Object[]} summaries - summary information about options
   * @param {string} summaries[].resource - resource option is for
   * @param {int} summaries[].optionalCount - count player can use of resource
   * @param {int} summaries[].clockwiseResource - count player can buy
   *     from clockwise player without other optional use
   * @param {int} summaries[].clockwiseOptional - count player can buy
   *     from clockwise player that have other optional use
   * @param {int} summaries[].counterClockwiseResource
   * @param {int} summaries[].counterClockwiseOptional
   * @param {int} summaries[].requiredCount - number of that resource required
   * @param {boolean} summaries[].isRequired - whether optional resource is
   *     required to meet requirements
   */
  pickValue(summaries, rates) {
    let bestOption = 0;
    for (i = 0; i < summaries.length; i++) {
      let currentBest = summaries[bestOption];
      if (summaries[i].isRequired) {
        return summaries[i].resource;
      }
      if (summaries[i].optionalCount <= summaries[i].requiredCount) {
        if (currentBest.optionalCount > currentBest.requiredCount) {
          bestOption = i;
        } else {
          const reducer = (acc, val) => acc + val.cost;
          const aveSavings = (costs, optionalCount) => {
            return (Math.min(...costs.filter(cost => !cost.usesOptional)) - 
                Math.min(...costs.filter(cost => cost.usesOptional))) / optionalCount;
          };
          let bestCosts = this.costToBuy(currentBest, rates).map((combo) => {
            return {
              totalCost: Object.values(combo).reduce(reducer, 0),
              usesOptional: combo.self.count > 0
            };
          });
          let currentCosts = this.costToBuy(summaries[i], rates).map((combo) => {
            return {
              totalCost: Object.values(combo).reduce(reducer, 0),
              usesOptional: combo.self.count > 0
            };
          });
          let bestSavings = aveSavings(bestCosts);
          let currentSavings = aveSavings(currentCosts);
          if (currentSavings > bestSavings) {
            bestOption = i;
          } else if (currentSavings === bestSavings &&
              (summaries[i].clockwiseResource +
              summaries[i].counterClockwiseResource <
              summaries[i].requiredCount)) {
              bestOption = i;
          }
        }
      } else if (currentBest.optionalCount > currentBest.requiredCount) {
        const reducer = (acc, val) => acc + val.cost;
        const aveSavings = (costs, optionalCount) => {
          return (Math.min(...costs.filter(cost => !cost.usesOptional)) - 
              Math.min(...costs.filter(cost => cost.usesOptional))) / optionalCount;
        };
        let bestCosts = this.costToBuy(currentBest, rates).map((combo) => {
          return {
            totalCost: Object.values(combo).reduce(reducer, 0),
            usesOptional: combo.self.count > 0
          };
        });
        let currentCosts = this.costToBuy(summaries[i], rates).map((combo) => {
          return {
            totalCost: Object.values(combo).reduce(reducer, 0),
            usesOptional: combo.self.count > 0
          };
        });
        let bestSavings = aveSavings(bestCosts);
        let currentSavings = aveSavings(currentCosts);
        if (currentSavings > bestSavings) {
          bestOption = i;
        } else if (currentSavings === bestSavings &&
            (summaries[i].clockwiseResource +
            summaries[i].counterClockwiseResource <
            summaries[i].requiredCount)) {
            bestOption = i;
        }
      }
    }
    return summaries[bestOption].resource;
  }

  /**
   * Pick best optional resource based on summaries and rates
   * @param {Object[]} summaries - summary information about options
   * @param {string} summary.resource - resource option is for
   * @param {int} summary.clockwiseResource - count player can buy
   *     from clockwise player without other optional use
   * @param {int} summary.counterResource
   * @param {int} summary.requiredCount - number of that resource required
   * @param {boolean} summary.isRequired - whether optional resource is
   *     required to meet requirements
   */
  costToBuy(summary, rates) {
    let combos = [];
    let maxClockwise = summary.clockwiseResource;
    let maxCounterClockwise = summary.counterResource;
    for (let i = 0; i <= maxClockwise && i <= summary.requiredCount; i++) {
      if (i + maxCounterClockwise >= summary.requiredCount) {
        combos.push({
          clockwise: {
            count: i,
            cost: i * rates.clockwise[summary.resource]
          },
          self: {count: 0, cost: 0},
          counterClockwise: {
            count: summary.requiredCount - i,
            cost: (summary.requiredCount - i) *
                rates.counterClockwise[summary.resource]
          }
        });
      }
    }
    return combos;
  }

  getRates() {
    let cardsPlayed = this.playersInfo[this.id].cardsPlayed || [];
    let clockwiseNatural = cardsPlayed.some(card => card.name === 'West Trading Post');
    let counterNatural = cardsPlayed.some(card => card.name === 'East Trading Post');
    let allNatural = this.playersInfo[this.id].wonderName === 'olympia' &&
        this.playersInfo[this.id].stagesInfo.some((stage) => {
          return stage.isBuilt && stage.custom === 'discount';
        });
    let clockwiseRate = clockwiseNatural || allNatural ? 1 : 2;
    let counterClockwiseRate = counterNatural || allNatural ? 1 : 2;
    let manufactureRate = cardsPlayed.some(card => card.name === 'Marketplace') ?
        1 : 2;
    return {
      clockwise: {
        C: clockwiseRate,
        S: clockwiseRate,
        O: clockwiseRate,
        W: clockwiseRate,
        L: manufactureRate,
        G: manufactureRate,
        P: manufactureRate
      },
      counterClockwise: {
        C: counterClockwiseRate,
        S: counterClockwiseRate,
        O: counterClockwiseRate,
        W: counterClockwiseRate,
        L: manufactureRate,
        G: manufactureRate,
        P: manufactureRate
      }
    };
  }

  checkResources(requirements, resourceObject) {
    requirements = {...requirements};
    Object.keys(requirements).forEach(function(key) {
      if (resourceObject[key]) {
        requirements[key] -= resourceObject[key];
        if (requirements[key] <= 0) {
          delete requirements[key];
        }
      }
    });
    return requirements;
  }
  
  /**
   * @returns {Object} requirements, usedOptions, usedIndices, usableOptions
   **/
  checkOptionalResources(requirements, usableOptions) {
    usableOptions = [...usableOptions];
    requirements = {...requirements};
    let continueChecking = usableOptions.length > 0;
    let usedOptions = [];
    while (continueChecking) {
      let usedIndices = [];
      continueChecking = false;
      for (let i = 0; i < usableOptions.length; i++) {
        let potentialResources = [];
        for (let j = 0; j < usableOptions[i].length; j++) {
          if (requirements[usableOptions[i][j]]) {
            potentialResources.push(usableOptions[i][j]);
          }
        }
        if (potentialResources.length === 1) {
          usedOptions.push(potentialResources[0]);
          usedIndices.push(i);
          requirements[potentialResources[0]] -= 1;
          if (requirements[potentialResources[0]] <= 0) {
            delete requirements[potentialResources[0]];
          }
          continueChecking = true;
        }
      }
      for (let i = usedIndices.length - 1; i >= 0; i--) {
        usableOptions.splice(usedIndices[i], 1);
      }
    }
    return {
      requirements,
      usedOptions,
      usableOptions
    };
  }

  resourceObject(resourceArray = []) {
    let resources = {withOptions: []};
    let ensureKey = (object, key) => object[key] ? true : object[key] = 0;
    resourceArray.forEach((resource) => {
      if (resource.includes('/')) {
        resources.withOptions.push(resource.split('/'));
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

  getNeighborsResource(requirements) {
    let neighbors = {
      clockwise: this.getNeighborResource(this.playersInfo[this.id].clockwisePlayer, {...requirements}),
      counterClockwise: this.getNeighborResource(this.playersInfo[this.id].counterClockwisePlayer, {...requirements})
    };
    return neighbors;
  }

  getNeighborResource(playerId, requirements) {
    let playerInfo = this.playersInfo[playerId];
    let resources = [];
    resources.push(playerInfo.wonderResource);
    if (playerInfo.cardsPlayed != null) {
      resources.push(...playerInfo.cardsPlayed.filter(card => card.isResource && ['brown', 'grey'].indexOf(card.color) > -1)
                                              .map(card => card.value));
    }
    let resourceObject = this.resourceObject(resources);
    requirements = this.checkResources(requirements, resourceObject);
    let optionalUse = this.checkOptionalResources(requirements, resourceObject.withOptions);
    requirements = optionalUse.requirements;
    resourceObject.withOptions = optionalUse.usableOptions
      .filter(options => options.some(opt => requirements[opt]));
    optionalUse.usedOptions.forEach(function(resource) {
      if (resourceObject[resource] == null) {
        resourceObject[resource] = 1;
      } else {
        resourceObject[resource] += 1;
      }
    });
    return resourceObject;
  }

  discardCard(card) {
    if (this.canPlay) {
      this.canPlay = false;
      this.emit('discard', this, card);
    }
  }

  buildWonder({card, clockwise, counterClockwise, self}) {
    if (this.canPlay) {
      const nextStage = this.wonder && this.wonder.stages.filter(s => !s.isBuilt)[0];
      if (nextStage) {
        nextStage.isBuilt = true;
        this.canPlay = false;
        this.emit('buildWonder', this, card, {clockwise, counterClockwise, self});
      }
    }
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
