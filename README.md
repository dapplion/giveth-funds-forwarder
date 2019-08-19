# Giveth Funds Forwarder

[![Build Status](https://travis-ci.com/dapplion/giveth-funds-forwarder.svg?branch=master)](https://travis-ci.com/dapplion/giveth-funds-forwarder)
[![Coverage Status](https://coveralls.io/repos/github/dapplion/giveth-funds-forwarder/badge.svg)](https://coveralls.io/github/dapplion/giveth-funds-forwarder)

Intermediate contract to allow donations from DAOs or other contracts to Giveth milestones via its bridge.

```
        Funds Forwarder Factory
                  ||
                  || deploy(receiverId)
                  \/
DAO ======> Funds Forwarder ======> Bridge ======> Milestone
    send ETH           forward(receiverId)
  transfer Token
```

The `FundsForwarder` is meant to be a proxy deployed by its factory `FundsForwarderFactory`. The current implementation uses [EIP 1167](https://github.com/ethereum/EIPs/blob/master/EIPS/eip-1167.md), a technique to deploy forwarding proxies (not upgradable) at very low gas costs. The `FundsForwarder` incorporates the [Initializable](https://hack.aragon.org/docs/common_Initializable) and [Petrifiable](https://hack.aragon.org/docs/common_Petrifiable) scheme used by [Aragon](https://github.com/aragon/aragonOS) to freeze the original logic contract and control proxy initialization. The initialization is done atomically in one transaction by the `FundsForwarderFactory`. The `FundsForwarder` contract also incorporates functionality from the Escapable contract by Jordi Baylina and Adrià Massanet to allow recovery of funds as a last resort if a security issue is uncovered.

## How to use it (front-end reference)

### Create a new funds forwarder

A revelant individual of a specific milestone or campaing should be shown a button "Create donation address" that calls `FundsForwarderFactory.newFundsForwarder(uint64 _giverId, uint64 _receiverId)`

The address of this contract will be constant and determined after deployment, so it should be hardcoded in the code.

**Sample code**

```js
import web3 from "./web3GetterOrSomething";
import fundsForwarderFactoryAbi from "contracts/fundsForwarderFactoryAbi.json";

const fundsForwarderFactoryAddress = "ALREADY_KNOWN";

const fundsForwarderFactory = web3.eth.Contract(
  fundsForwarderFactoryAbi,
  fundsForwarderFactoryAddress
);

async function createDonationAddress() {
  const receipt = await fundsForwarderFactory.methods
    .newFundsForwarder(giverId, receiverId)
    .send();

  const newFundForwarderEvent = receipt.events.find(
    ({ event }) => event === "NewFundForwarder"
  );
  const donationAddress = newFundForwarderEvent.returnValues.fundsForwarder;
  return donationAddress;
}
```

**Address**

```
TBA
```

**ABI**

```json
[
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "name": "_giver",
        "type": "address"
      },
      {
        "indexed": true,
        "name": "_receiverId",
        "type": "uint64"
      },
      {
        "indexed": false,
        "name": "fundsForwarder",
        "type": "address"
      }
    ],
    "name": "NewFundForwarder",
    "type": "event"
  },
  {
    "constant": false,
    "inputs": [
      {
        "name": "_giverId",
        "type": "uint64"
      },
      {
        "name": "_receiverId",
        "type": "uint64"
      }
    ],
    "name": "newFundsForwarder",
    "outputs": [],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "function"
  }
]
```

### Send funds to the funds forwarder

Regular ethereum token or ETH transaction

### Forward funds to the bridge

The UI should query the balance of each funds forwarder contract of the milestones that the user is insterested in.

If a sufficient balance of one or multiple tokens is found for a giveth funds forwarder contract, the front end should alert the user and offer a button "Forward to the Bridge" or "Collect donations". This button should trigger the function `FundsForwarder.forwardMultiple(address[] _tokens)`.

**Sample code**

```js
import web3 from "./web3GetterOrSomething";
import fundsForwarderAbi from "contracts/fundsForwarderAbi.json";
import erc20Abi from "contracts/erc20Abi.json";

const whitelistedTokens = [
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "0xB8c77482e45F1F44dE1745F52C74426C631bDD52",
  "0x2af5d2ad76741191d15dfe7bf6ac92d4bd912ca3",
  "0x514910771af9ca656af840dff83e8264ecf986ca",
  "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2"
];

const minimumBalanceToForward = web3.utils.toWei("0.1");

async function forwardToTheBridge(fundsForwarderAddress) {
  const tokensToForward = [];

  for (const tokenAddress of whitelistedTokens) {
    const erc20 = web3.eth.Contract(erc20Abi, tokenAddress);
    const balance = await erc20.methods.balanceOf(fundsForwarderAddress).call();
    if (balance > minimumBalanceToForward) tokensToForward.push(tokenAddress);
  }

  if (!tokensToForward.length) return;

  const fundsForwarder = web3.eth.Contract(
    fundsForwarderAbi,
    fundsForwarderAddress
  );

  await fundsForwarder.methods.forwardMultiple(tokensToForward).send();
}
```

**Address**

```
Fetched dynamically
```

**ABI**

```json
[
  {
    "constant": false,
    "inputs": [
      {
        "name": "_tokens",
        "type": "address[]"
      }
    ],
    "name": "forwardMultiple",
    "outputs": [],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "function"
  }
]
```

## Gas costs

| Action                                        | Gas cost  | Frequency                                          |
| --------------------------------------------- | --------- | -------------------------------------------------- |
| Deploy FundsForwarderFactory (w/ child logic) | 3,654,402 | Once                                               |
| Deploy FundForwarder                          | 117,087   | Once for each applicable milestone                 |
| Forward ETH to bridge                         | 39,297    | Every time each milestone requires the funds       |
| Forward Tokens (DAI) to bridge                | 78,596    | First time each milestone requires the funds       |
| Forward Tokens (DAI) to bridge                | 39,103    | Every other time each milestone requires the funds |
| Forward multiple tokens (ETH, DAI, FAKEERC20) | 80,660    | -                                                  |

Gas costs without proxy are: Deploy FundForwarder +1,317%, Forward ETH to bridge -2%, Forward Tokens to bridge -1%.

## How to deploy

Only one contract has to be deployed (`FundsForwarderFactory`), which will deploy the logic of the child contract and do all the setup actions.

The flattened code of the contract is ready to be copy / pasted to remix and can be found in [flattened_contracts/FundsForwarderFactory.sol](flattened_contracts/FundsForwarderFactory.sol). If the code is re-compiled from source, use solidity version `0.4.24+commit.e67f0147` and enable the optimizer.

The arguments for the constructor are:

| Argument                 | Value                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| \_bridge                 | [`0x30f938fED5dE6e06a9A7Cd2Ac3517131C317B1E7`](https://etherscan.io/address/0x30f938fed5de6e06a9a7cd2ac3517131c317b1e7) |
| \_escapeHatchCaller      | [`0x1e9F6746147E937E8E1C29180e15aF0bd5fd64bb`](https://etherscan.io/address/0x1e9f6746147e937e8e1c29180e15af0bd5fd64bb) |
| \_escapeHatchDestination | [`0x16Fda2Fcc887Dd7Ac65c46Be144473067CfF8654`](https://etherscan.io/address/0x16fda2fcc887dd7ac65c46be144473067cff8654) |
| \_childImplementation    | 0x0000000000000000000000000000000000000000                                                                              |

**SECURITY NOTE**: The FundsForwarderFactory contract will immediately grant its ownership to the bridge owner. The address deploying the contract will have no special priviledges on the FundsForwarderFactory and FundsForwarders at any time.

**RE-REPLOYMENT NOTE**: If you want to deploy a second FundsForwarderFactory contract and not re-deploy the childImplementation, you must pass its address as a contructor argument, and you should modify the FundsForwarder code from the FundsForwarderFactory to save around ~1,500,000 gas on deployment.
