"use strict";

const WebSocket = require('ws');

class Player {
  constructor(options = {}) {
    this._name = options.name || `player-${Date.now()}`;
    if (options.id) this._id = options.id;
    this._isInGame = false;
    this._autoPlay = options.autoPlay == null || options.autoPlay;
    this._socket = new WebSocket('ws://localhost/get_socket');
    this._socket.onmessage = this.serverMessage.bind(this);
    this.login();
  }

  set name(name) {
    this._name = name;
  }

  get name() {
    return this._name;
  }

  get socket() {
    return this._socket;
  }

  set lastMessage(msg) {
    this._lastMsg = msg;
  }

  get lastMessage() {
    return this._lastMsg;
  }

  set id(id) {
    this._id = id;
  }

  get id() {
    return this._id;
  }

  set autoPlay(autoPlay) {
    this._autopPlay = autoPlay;
  }

  get autoPlay() {
    return this._autoPlay;
  }

  set isInGame(isInGame) {
    this._isInGame = isInGame;
  }

  get isInGame() {
    return this._isInGame;
  }

  set cards(cards) {
    this._cards = cards;
  }

  get cards() {
    return this._cards;
  }

  set canPlay(canPlay) {
    this._canPlay = canPlay;
  }

  get canPlay() {
    return this._canPlay;
  }

  serverMessage(msg) {
    var parsedMsg = JSON.parse(msg.data);
    this.lastMessage = parsedMsg;
    //console.log('message type', parsedMsg.messageType);
    if (parsedMsg.messageType === 'myname') {
      this.id = parsedMsg.id;
    } else if (parsedMsg.messageType === 'newgame') {
      if (this.autoPlay && !this.isInGame) {
        this.joinGame(parsedMsg.id);
      }
    } else if (parsedMsg.messageType === 'startinfo') {
      if (parsedMsg.wonderside) {
        // game has already started...
      } else {
        this.chooseWonder();
      }
    } else if (parsedMsg.messageType === 'hand') {
      this.setHand(parsedMsg.cards);
    } else if (parsedMsg.messageType === 'possibilities') {
      this.handlePossibilities(parsedMsg);
    } else if (parsedMsg.messageType === 'scores') {
      this.handleScores(parsedMsg);
    }
  }

  sendMessage(data) {
    //console.log('send', data);
    this.socket.send(JSON.stringify(data));
  }

  login() {
    this.socket.once('open', () => {
      this.sendMessage({
        name: this.name,
        id: this.id,
        messageType: 'myid'
      })
    });
  }

  joinGame(id) {
    this.sendMessage({id: id, messageType: 'joingame'});
    this.isInGame = true;
  }

  chooseWonder() {
    if (this.autoPlay) {
      this.sendMessage({
        messageType: 'wonderside',
        value: Date.now() % 2 === 0
      });
    }
  }

  startGame(args) {
  }

  checkResources(card, type = 'play') {
    this.sendMessage({
      messageType: 'checkresources',
      type: type,
      value: card.name
    });
  }

  playCard(card, type = 'play', combo = 0) {
    if (this.canPlay) {
      this.sendMessage({
        messageType: 'cardplay',
        value: [card.name, type, combo]
      });
      this.canPlay = false;
    }
  }

  checkCards(cards) {
    cards.forEach((card) => this.checkResources(card));
  }

  setHand(cards) {
    this.canPlay = true;
    if (Array.isArray(cards))
      this.cards = cards
    else
      this.cards = Object.values(cards);
    if (this.autoPlay)
      this.checkCards(this.cards);
  }

  handlePossibilities(args) {
    this.cards.filter((card) => card.name === args.card)
      .forEach((card) => card[args.type] = args.combs);
    process.nextTick(() => {
      if (this.autoPlay && this.cards.every((card) => card.play)) {
        let freePlays = this.cards
          .filter((card) => card.play.length > 0 && Object.values(card.play[0])
            .every((value) => value === 0));
        if (freePlays.length > 0) {
          let card = freePlays[Math.floor(Math.random() * freePlays.length)];
          this.playCard(card);
        } else {
          let costlyPlays = this.cards.filter((card) => card.play.length > 0);
          if (costlyPlays.length > 0) {
            let card = costlyPlays[Math.floor(Math.random() * costlyPlays.length)];
            this.playCard(card)
          } else {
            this.playCard(this.cards[Math.floor(Math.random() * this.cards.length)], 'trash');
          }
        }
      }
    });
  }

  handleScores(args) {
    if (this.autoPlay) {
      this.socket.close();
    }
  }
}

module.exports = Player;
