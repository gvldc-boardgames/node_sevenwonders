CREATE INDEX ON :AgeOneCard(players); 
CREATE INDEX ON :AgeThreeCard(players); 
CREATE INDEX ON :AgeTwoCard(players); 

CREATE INDEX ON :AgeOneCard(name, players);
CREATE INDEX ON :AgeOneCardInstance(name, players, gameId);
CREATE INDEX ON :AgeThreeCard(name, players);
CREATE INDEX ON :AgeThreeCardInstance(name, players, gameId);
CREATE INDEX ON :AgeTwoCard(name, players);
CREATE INDEX ON :AgeTwoCardInstance(name, players, gameId);
CREATE INDEX ON :Game(gameId);
CREATE INDEX ON :Player(playerId);
CREATE INDEX ON :Wonder(name);
