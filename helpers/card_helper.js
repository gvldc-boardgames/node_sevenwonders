exports.shuffleCards = function(cards) {
  if (Array.isArray(cards)) {
    let shuffled = [];
    let length = cards.length;
    for (let i = 0; i < length; i++) {
      let randomIndex = Math.floor(Math.random() * cards.length);
      shuffled.push(...cards.splice(randomIndex,1));
    }
    return shuffled;
  } else {
    throw new Error('shuffleCards only shuffles arrays');
  }
}

exports.deal = function(cards, totalHands, perHand) {
  if (cards.length < (totalHands * perHand)) {
    throw new Error('Insufficient cards for dealing');
  } else {
    let hands = [];
    for (let i = 0; i < totalHands; i++)
      hands.push([]);
    while (!hands.every((hand) => hand.length === perHand)) {
      for (let i = 0; i < hands.length; i++)
        hands[i].push(cards.shift());
    }
    return hands;
  }
}
