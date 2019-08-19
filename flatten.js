const flatten = require("truffle-flattener");
const fs = require("fs");
const path = require("path");

const contracts = ["FundsForwarder.sol", "FundsForwarderFactory.sol"];

const FLATTEN_DIR = "./flattened_contracts";

fs.mkdir(FLATTEN_DIR, { recursive: true }, e => {
  if (e) console.log(e);
});

for (const contract of contracts) {
  flatten([`contracts/${contract}`]).then(flattenedCode => {
    fs.writeFileSync(path.join(FLATTEN_DIR, contract), flattenedCode);
  });
}
