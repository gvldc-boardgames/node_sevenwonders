#!/bin/bash

NEO4J_HOME="/var/lib/neo4j"
# todo - use env variable for password
$NEO4J_HOME/bin/cypher-shell -u neo4j -p neo4j "CALL dbms.changePassword('BoardGames');"
cat $NEO4J_HOME/import/constraints.cypher | $NEO4J_HOME/bin/cypher-shell -u neo4j -p BoardGames --format plain
cat $NEO4J_HOME/import/loadcsv.cypher | $NEO4J_HOME/bin/cypher-shell -u neo4j -p BoardGames --format plain
