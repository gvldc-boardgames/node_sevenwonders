"use strict";
const express = require('express');
const Player = require('./player');
const app = express();

app.post('/newbot', (req, res) => { 
  new Player()
  res.send('New bot!');
});

app.listen(8008);
