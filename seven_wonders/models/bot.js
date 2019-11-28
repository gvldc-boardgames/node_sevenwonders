const Player = require('./player');

class Bot extends Player {
  constructor(options = {}) {
    super(options);
  }

  receiveWonderOption(wonderOption) {
    this.wonderOption = wonderOption;
    const side = ['a', 'b'][Math.floor(Math.random() * 100) % 2];
    this.chooseWonderSide({wonderName: wonderOption.wonderName, side});
  }

  freeWonderPlay(possibleCards) {
    // TODO: pick a better card
    this.emit('freePlayChosen', possibleCards[0]);
  }

  receiveHand(hand) {
    const promises = [];
    this.hand = hand;
    this.canPlay = true;
    setImmediate(() => this.decidePlay());
  }

  decidePlay() {
    this.hand.forEach(card => this.getCombos(card));
    const play = this.hand.filter(card => card.playCombos.length > 0)[0];
    if (play != null) {
      this.playCard({card: play, ...play.playCombos[0]});
    } else {
      this.discardCard(this.hand[0]);
    }
  }
}

module.exports = Bot;
