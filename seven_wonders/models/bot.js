const Player = require('./player');

class Bot extends Player {
  constructor(options = {}) {
    super(options);
    this.ratedPlays = [];
    this.resourceFactor = options.resourceFactor || 1;
    this.scienceFactor = options.scienceFactor || 1;
    this.wonderFactor = options.wonderFactor || 1;
    this.culturalFactor = options.culturalFactor || 1;
    this.militaryFactor = options.militaryFactor || 1;
    this.guildFactor = options.guildFactor || 1;
  }

  receiveWonderOption(wonderOption) {
    this.wonderOption = wonderOption;
    const side = ['a', 'b'][Math.floor(Math.random() * 100) % 2];
    this.chooseWonderSide({wonderName: wonderOption.wonderName, side});
  }

  freeWonderPlay(possibleCards) {
    console.log('bot free wonder play', possibleCards);
    // TODO: pick a better card
    this.emit('freePlayChosen', possibleCards[0]);
  }

  receiveHand(hand) {
    this.ratedPlays = [];
    this.hand = hand;
    this.canPlay = true;
    setTimeout(() => this.getRatings(), 3000);
  }

  getRatings() {
    this.hand.forEach(card => this.getCombos(card));
    this.ratePlays(this.hand.filter(card => card.playCombos.length > 0));
    this.ratedPlays.push(this.rateBuildWonder());
    this.decidePlay();
  }


  decidePlay() {
    // default to discarding
    let bestPlay = {type: 'discard', rating: 0};
    this.ratedPlays.forEach((play) => {
      if (play.rating > bestPlay.rating) {
        bestPlay = play;
      }
    });
    console.log(`Bot ${this.name} will ${bestPlay.type} with rating of ${bestPlay.rating}`);
    if (bestPlay.type === 'play') {
      this.playCard({card: bestPlay.card, ...bestPlay.card.playCombos[0]});
    } else {
      const card = this.pickCardToTrash();
      if (bestPlay.type === 'wonder') {
        this.buildWonder({card, ...(this.getWonderCombos()[0])});
      } else {
        this.discardCard(card);
      }
    }
  }

  ratePlays(cards = []) {
    this.ratedPlays.push(...cards.map((card) => this.ratePlay(card)));
  }

  rateResource(card) {
    const wonderReqs = this.wonder.stages.filter(s => !s.isBuilt)
        .map(s => this.getWonderRequirements(s));
    console.log(wonderReqs)
    // get the requirements that current card meets multiplied by the resourceFactor
    return wonderReqs.flatMap(req => Object.keys(req))
        .filter(req => card.value.indexOf(req) > -1)
        .length * this.resourceFactor;
  }

  // incentivise getting one of each science
  rateScience(card) {
    const cardsPlayed = this.playersInfo[this.id].cardsPlayed || [];
    return (5 - cardsPlayed.filter(c => c.value === card.value).length) * this.scienceFactor;
  }

  rateMilitary(card) {
    const {myMilitary, neighbors} = this.getMilitaryValues();
    const compareStrength = (str) => str < myMilitary ? 0 : str > myMilitary ? this.militaryFactor : this.militaryFactor / 2;
    return neighbors.reduce((acc, curr) => acc + compareStrength(curr), 0);
  }

  rateCultural(card) {
    return (+card.value + (card.freeBuilds || []).length) * this.culturalFactor;
  }

  ratePlay(card) {
    const cardRating = {card, type: 'play', rating: -this.getComboCost(card.playCombos[0])};
    if (card.isResource) {
      cardRating.rating += this.rateResource(card);
    } else if (card.color === 'blue') {
      cardRating.rating += this.rateCultural(card);
    } else if (card.color === 'green') {
      cardRating.rating += this.rateScience(card);
    } else if (card.color === 'red') {
      cardRating.rating += this.rateMilitary(card);
    } else if (card.color === 'purple') {
      cardRating.rating += this.guildFactor;
    } else {
      cardRating.rating += 1;
    }
    console.log(`${this.name} rated: ${card.name} - ${card.color} at ${cardRating.rating}`);
    return cardRating;
  }

  rateBuildWonder() {
    const wonderCombos = this.getWonderCombos();
    if (wonderCombos.length > 0) {
      const rating = this.wonderFactor - this.getComboCost(wonderCombos[0]);
      console.log('wonder rating', rating);
      return {type: 'wonder', rating};
    } else {
      return {type: 'wonder', rating: -1};
    }
  }
  getWonderRequirements(stage) {
    let requirements = this.resourceObject(stage.cost.split(''));
    const resources = this.getMyResources();
    Object.keys(requirements).filter(key => key.length !== 1)
        .forEach(key => delete requirements[key]);
    requirements = this.checkResources(requirements, resources);
    return this.checkOptionalResources(requirements, resources.withOptions.filter(opt => opt.some(opt => requirements[opt]))).requirements;
  }

  rateTrash(card) {
    const colorMap = {
      yellow: 0,
      red: 3 * this.militaryFactor,
      gray: 1 * this.resourceFactor,
      brown: 1 * this.resourceFactor,
      purple: 2 * this.guildFactor,
      green: 9 * this.scienceFactor,
      blue: 5 * this.culturalFactor,
    };
    return {type: 'trash', card, rating: Math.random() * 10 + (colorMap[card.color] || 0)};
  }

  pickCardToTrash() {
    // default to trash first card
    let trashCard = {rating: 0, card: this.hand[0],};
    this.hand.forEach((card) => {
      const ratedCard = this.rateTrash(card);
      if (ratedCard.rating > trashCard.rating) {
        trashCard = ratedCard;
      }
    });
    return trashCard.card;
  }

  getMilitaryValues() {
    const getMilitary = (id) => this.playersInfo[id].military;
    const myMilitary = getMilitary(this.id);
    const neighbors = [
      getMilitary(this.playersInfo[this.id].clockwisePlayer),
      getMilitary(this.playersInfo[this.id].counterClockwisePlayer),
    ];
    return {myMilitary, neighbors};
  }

  getComboCost(combo) {
    return Object.values(combo).reduce((acc, {cost}) => acc + cost, 0);
  }
}

module.exports = Bot;
