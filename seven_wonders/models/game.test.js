const Game = require('./game');
// test cases from when error thrown in game: game-1584574777478 bug #14
describe('When calculate science score', () => {
  test('can calculate if empty', () => {
    const game = new Game({maxPlayers: 3, name: 'test-game'});
    const scienceValues = [];
    const scienceScore = game.calculateScienceScore(scienceValues);
    expect(scienceScore).toBe(0);
  });
  test('can calculate if no variable', () => {
    const game = new Game({maxPlayers: 3, name: 'test-game'});
    const scienceValues = ['&', '@', '#', '&', '&'];
    const scienceScore = game.calculateScienceScore(scienceValues);
    expect(scienceScore).toBe(18);
  });
  test('can calculate if two variable', () => {
    const game = new Game({maxPlayers: 3, name: 'test-game'});
    const scienceValues = ['&/@/#', '#', '&', '@', '&/@/#', '#', '#'];
    const scienceScore = game.calculateScienceScore(scienceValues);
    expect(scienceScore).toBe(34);
  });
});
