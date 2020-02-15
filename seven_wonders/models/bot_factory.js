const Bot = require('./bot');

const _playStyles = [
  { // blue and wonder
    militaryFactor: 2,
    scienceFactor: 3 / 5,
    guildFactor: 5,
    wonderFactor: 7,
    resourceFactor: 4,
    culturalFactor: 1,
  },
  { // war and science
    militaryFactor: 5,
    scienceFactor: 1,
    guildFactor: 4,
    wonderFactor: 5,
    resourceFactor: 2,
    culturalFactor: 1 / 4,
  },
  { // scientist
    militaryFactor: 3,
    scienceFactor: 3,
    guildFactor: 1,
    wonderFactor: 3,
    resourceFactor: 2,
    culturalFactor: 1,
  },
];

const createBot = (options = {}) => {
  const playStyle = _playStyles[Math.floor(Math.random() * _playStyles.length)];
  return new Bot({...playStyle, ...options});
};

module.exports = createBot;
