const Player = require('./player');

const getPlayer = ({wonderStage = 0, coins = 0, playerResources = [], leftResources = [], rightResources = []}) => {
  const player = new Player({name: 'test.user', id: 'test1'});
  const colorMap = {
    L: 'gray',
    G: 'gray',
    P: 'gray',
    C: 'brown',
    S: 'brown',
    O: 'brown',
    W: 'brown',
  };
  player.playersInfo = {
    test1: {
      cardsPlayed: playerResources.map(r => ({isResource: true, value: r})),
      coins,
      wonderResource: 'G',
      stagesInfo: [
        {
          isResource: true,
          stage: 1,
          resource: 'C/S/O/W',
          isBuilt: 1 <= wonderStage,
        },
        {
          isResource: true,
          stage: 2,
          resource: 'L/G/P',
          isBuilt: 2 <= wonderStage,
        },
        {
          isResource: false,
          stage: 3,
          points: 7,
          isBuilt: 3 <= wonderStage,
        }
      ],
      clockwisePlayer: 'clockwise',
      counterClockwisePlayer: 'counterClockwise',
    },
    clockwise: {
      wonderResource: 'G',
      cardsPlayed: leftResources.map(r => ({isResource: true, color: colorMap[r], value: r})),
    },
    counterClockwise: {
      wonderResource: 'G',
      cardsPlayed: rightResources.map(r => ({isResource: true, color: colorMap[r], value: r})),
    },
  };
  return player;
};

const getStudy = () => {
  return {
    name: 'Study',
    players: 3,
    type: 'science',
    color: 'green',
    value: '&',
    cost: 'WPL',
  };
}
  
describe('When build study', () => {
  test('Can build if have resources', () => {
    const study = getStudy();
    const player = getPlayer({playerResources: ['W', 'P', 'L']});
    expect(player.getCombos(study)).toBe(true);
  });
  test('Can build if have cash', () => {
    const study = getStudy();
    const player = getPlayer({coins: 6, leftResources: ['W', 'P'], rightResources: ['L']});
    expect(player.getCombos(study)).toBe(true);
  });
  test('Cannot build if missing resources and cash', () => {
    const study = getStudy();
    const player = getPlayer({wonderStage: 3});
    expect(player.getCombos(study)).toBe(false);
  });
  test('Can build if has wonder stages and neighbor has missing', () => {
    const study = getStudy();
    const player = getPlayer({wonderStage: 2, coins: 2, leftResources: ['W', 'P'], rightResources: ['L']});
    expect(player.getCombos(study)).toBe(true);
  });
  test('Can build if has optional resources', () => {
    const study = getStudy();
    const player = getPlayer({wonderStage: 2, playerResources: ['L/G/P']});
    expect(player.getCombos(study)).toBe(true);
  });
});

