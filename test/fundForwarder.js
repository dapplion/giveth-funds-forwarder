// HashtagList
const FundsForwarderFactory = artifacts.require("FundsForwarderFactory");
const FundsForwarder = artifacts.require("FundsForwarder");
const GivethBridge = artifacts.require("GivethBridge");
const ERC20Insecure = artifacts.require("ERC20Insecure");
const InsecureDaiToken = artifacts.require("InsecureDSToken");
const assert = require("assert");
const { BN, toBN } = web3.utils;

/**
 * Utility to abstract comparing a balance before and after an action
 * @param {string} address
 */
async function compareBalance(address, erc20) {
  const getBalance = () =>
    erc20 ? erc20.balanceOf(address) : web3.eth.getBalance(address);
  const balancePre = await getBalance();
  return async function getDiff() {
    const balanceAfter = await getBalance();
    return toBN(balanceAfter)
      .sub(toBN(balancePre))
      .toString();
  };
}

/**
 * Test utility to assert a contract tx error
 *
 * @param {function} fn
 * @param {string} message "INIT_ALREADY_INITIALIZED"
 * The message will actually be expected to be:
 * "Returned error: VM Exception while processing transaction: revert INIT_ALREADY_INITIALIZED -- Reason given: INIT_ALREADY_INITIALIZED.",
 */
async function shouldRevertWithMessage(fn, message) {
  let errorMessage = "---did not throw---";
  let didThrow = false;
  try {
    await fn();
  } catch (e) {
    didThrow = true;
    errorMessage = e.message;
  }
  assert.equal(didThrow, true, "Function did not throw");
  assert.equal(
    errorMessage,
    `Returned error: VM Exception while processing transaction: revert ${message} -- Reason given: ${message}.`,
    "Wrong error message"
  );
}

/**
 * Utility to get a log from a transaction
 * @param {object} logs, tx.logs or events
 * @param {string} eventName
 */
function getEvent(logs, eventName) {
  const log = logs.find(({ event }) => event === eventName);
  assert.ok(log, `Log ${eventName} not found in TX`);
  return log;
}

/**
 * Turn a number string negative
 * @param {string} s 100000
 * @return {string} -100000
 */
const neg = s => "-" + s;
/**
 * Construct an getPastBlocks options object from a tx object
 * @param {object} tx
 */
const lastBlock = tx => ({
  fromBlock: tx.receipt.blockNumber,
  toBlock: tx.receipt.blockNumber
});

/**
 * Get the deploy gas cost of a contract instance
 * @param {object} contractInstance
 */
async function getContractDeployGas(contractInstance) {
  if (!contractInstance.transactionHash) return "No txHash";
  const receipt = await web3.eth.getTransactionReceipt(
    contractInstance.transactionHash
  );
  if (!receipt) return "No receipt";
  return receipt.gasUsed;
}

contract("FundsForwarder", accounts => {
  // Accounts
  const bossAccount = accounts[0];
  const campaignManagerAccount = accounts[1];
  const donorAccount = accounts[2];
  const claimerAccount = accounts[3];
  const safeVaultAccount = accounts[9];
  console.log({
    bossAccount,
    campaignManagerAccount,
    donorAccount,
    claimerAccount,
    safeVaultAccount
  });

  /**
   * Contract instances
   *
   * instance.address = "0x686Feb2e528eed3043239F6A5B42ca3BF7ddc6B2"
   * await instance.method(arg1, arg2, {from: account})
   *
   */
  let bridge;
  let fundsForwarderFactory;
  let fundsForwarder;
  let erc20;
  let dai;
  let gasData = {};
  let gasPrice = 1e9;

  // Giveth bridge params
  // - Shared
  const escapeHatchCaller = bossAccount;
  const escapeHatchDestination = safeVaultAccount;
  // - Dedicated
  const securityGuard = bossAccount;
  const absoluteMinTimeLock = 60 * 60 * 25;
  const timeLock = 60 * 60 * 48;
  const maxSecurityGuardDelay = 60 * 60 * 24 * 5;
  // - DApp
  const giverId = 43271;
  const receiverId = 5683;
  const donationValue = web3.utils.toWei("0.1", "ether");
  const donationValueBn = toBN(donationValue);
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const nonContractAddress = "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359";
  const maxValue = toBN(2)
    .pow(toBN(255))
    .toString();

  before(
    "Deploy Giveth bridge, FundsForwarderFactory and FundsForwarder logic",
    async () => {
      // Bridge deployment
      bridge = await GivethBridge.new(
        escapeHatchCaller,
        escapeHatchDestination,
        absoluteMinTimeLock,
        timeLock,
        securityGuard,
        maxSecurityGuardDelay
      );

      // FundsForwarderFactory deployment
      fundsForwarderFactory = await FundsForwarderFactory.new(
        bridge.address,
        escapeHatchCaller,
        escapeHatchDestination,
        zeroAddress
      );
      gasData["Deploy FundsForwarderFactory"] = await getContractDeployGas(
        fundsForwarderFactory
      );

      // Get the fundsForwarderLogic address that was deployed
      // in the FundsForwarderFactory constructor
      fundsForwarderLogic = fundsForwarder = await FundsForwarder.at(
        await fundsForwarderFactory.childImplementation()
      );
    }
  );

  it(`fundsForwarderLogic should be petrified`, async () => {
    const fundsForwarderFactoryAddress = await fundsForwarderLogic.fundsForwarderFactory();
    assert.equal(
      fundsForwarderFactoryAddress.toLowerCase(),
      "0xffffffffffffffffffffffffffffffffffffffff",
      "Should be petrified"
    );
  });

  it(`fundsForwarderLogic should not be able to be initialized`, async () => {
    await shouldRevertWithMessage(
      () => fundsForwarderLogic.initialize(giverId, receiverId),
      "INIT_ALREADY_INITIALIZED"
    );
  });

  it(`campaignManager should deploy FundsForwarder via the factory`, async () => {
    const tx = await fundsForwarderFactory.newFundsForwarder(
      giverId,
      receiverId,
      { from: campaignManagerAccount }
    );
    gasData["Deploy FundForwarder"] = tx.receipt.gasUsed;

    const newFundForwarder = getEvent(tx.logs, "NewFundForwarder");
    fundsForwarder = await FundsForwarder.at(
      newFundForwarder.args.fundsForwarder
    );

    // Check that the ids are correct
    const _receiverId = await fundsForwarder.receiverId();
    const _giverId = await fundsForwarder.giverId();
    assert.equal(_receiverId, receiverId, "Wrong receiverId");
    assert.equal(_giverId, giverId, "Wrong giverId");
  });

  it(`fundsForwarder should not be able to be initialized twice`, async () => {
    await shouldRevertWithMessage(
      () => fundsForwarderLogic.initialize(giverId, receiverId),
      "INIT_ALREADY_INITIALIZED"
    );
  });

  describe("ETH donation", () => {
    it(`Should send ETH to the fundsForwarder`, async () => {
      const balanceDonor = await compareBalance(donorAccount);
      const balanceFundF = await compareBalance(fundsForwarder.address);

      const tx = await fundsForwarder.send(donationValue, {
        from: donorAccount
      });

      const gasCost = toBN(tx.receipt.gasUsed).mul(toBN(gasPrice));
      const txCost = donationValueBn.add(gasCost).toString();
      const balDonorDiff = await balanceDonor();
      const balFundFDiff = await balanceFundF();
      // The gas price changes between test and coverage, but gasPrice always returns 1e9
      assert.equal(
        balDonorDiff.slice(0, 4),
        neg(txCost).slice(0, 4),
        "Wrong donor balance"
      );
      assert.equal(
        balDonorDiff.length,
        neg(txCost).length,
        "Wrong donor balance"
      );
      assert.equal(balFundFDiff, donationValue, "Wrong fund f. balance");
    });

    it(`Should call forward and move the ETH to the bridge`, async () => {
      const balanceBridg = await compareBalance(bridge.address);
      const balanceFundF = await compareBalance(fundsForwarder.address);

      const tx = await fundsForwarder.forward(zeroAddress, {
        from: claimerAccount
      });
      gasData["Forward ETH tx"] = tx.receipt.gasUsed;
      const forwarded = getEvent(tx.logs, "Forwarded");
      assert.equal(
        forwarded.args.balance.toString(),
        donationValue,
        "Wrong balance in Forwarded event"
      );

      const balBridgDiff = await balanceBridg();
      const balFundFDiff = await balanceFundF();
      assert.equal(balBridgDiff, donationValue, "Wrong bridge balance");
      assert.equal(balFundFDiff, neg(donationValue), "Wrong fund f. balance");

      const events = await bridge.getPastEvents("allEvents", lastBlock(tx));
      const donate = getEvent(events, "Donate");
      assert.deepEqual(
        {
          giverId: donate.args.giverId.toNumber(),
          receiverId: donate.args.receiverId.toNumber(),
          token: donate.args.token,
          amount: donate.args.amount.toString()
        },
        {
          giverId,
          receiverId,
          token: zeroAddress,
          amount: donationValue
        },
        "Wrong event Donate arguments"
      );
    });
  });

  /**
   * Tokens
   */

  describe("ERC20 token donation", () => {
    before("Deploy ERC20, mint and whitelist in the bridge", async () => {
      erc20 = await ERC20Insecure.new();
      await erc20.mint(donorAccount, maxValue);
      const balance = await erc20
        .balanceOf(donorAccount)
        .then(b => b.toString());
      if (balance !== maxValue)
        throw Error(`Wrong donor minted balance ${balance} == ${maxValue}`);
      await bridge.whitelistToken(erc20.address, true);
    });

    it(`Should send tokens to the fundsForwarder`, async () => {
      const balanceDonor = await compareBalance(donorAccount, erc20);
      const balanceFundF = await compareBalance(fundsForwarder.address, erc20);

      const tx = await erc20.transfer(fundsForwarder.address, donationValue, {
        from: donorAccount
      });

      const balDonorDiff = await balanceDonor();
      const balFundFDiff = await balanceFundF();
      assert.equal(balDonorDiff, neg(donationValue), "Wrong donor balance");
      assert.equal(balFundFDiff, donationValue, "Wrong fund f. balance");
    });

    it(`Should call forward and move the tokens to the bridge`, async () => {
      const balanceBridg = await compareBalance(bridge.address, erc20);
      const balanceFundF = await compareBalance(fundsForwarder.address, erc20);

      const tx = await fundsForwarder.forward(erc20.address, {
        from: claimerAccount
      });
      gasData["Forward fake ERC20 Tokens tx"] = tx.receipt.gasUsed;
      const forwarded = getEvent(tx.logs, "Forwarded");
      assert.equal(
        forwarded.args.balance.toString(),
        donationValue,
        "Wrong balance in Forwarded event"
      );

      const balBridgDiff = await balanceBridg();
      const balFundFDiff = await balanceFundF();
      assert.equal(balBridgDiff, donationValue, "Wrong bridge balance");
      assert.equal(balFundFDiff, neg(donationValue), "Wrong fund f. balance");

      const events = await bridge.getPastEvents("allEvents", lastBlock(tx));
      const donate = getEvent(events, "Donate");
      assert.deepEqual(
        {
          giverId: donate.args.giverId.toNumber(),
          receiverId: donate.args.receiverId.toNumber(),
          token: donate.args.token,
          amount: donate.args.amount.toString()
        },
        {
          giverId,
          receiverId,
          token: erc20.address,
          amount: donationValue
        },
        "Wrong event Donate arguments"
      );
    });
  });

  /**
   * DAI token interactions
   */
  describe("DAI token consecutive donation", () => {
    before("Deploy DAI, mint and whitelist in the bridge", async () => {
      dai = await InsecureDaiToken.new(web3.utils.asciiToHex("DAI", 32));
      await dai.mint(maxValue, { from: donorAccount });
      const balance = await dai.balanceOf(donorAccount).then(b => b.toString());
      if (balance !== maxValue)
        throw Error(`Wrong donor minted balance ${balance} == ${maxValue}`);
      await bridge.whitelistToken(dai.address, true);
    });

    for (let i = 1; i <= 3; i++) {
      it(`Should send tokens to the fundsForwarder - tx #${i}`, async () => {
        const balanceDonor = await compareBalance(donorAccount, dai);
        const balanceFundF = await compareBalance(fundsForwarder.address, dai);

        const tx = await dai.transfer(fundsForwarder.address, donationValue, {
          from: donorAccount
        });

        const balDonorDiff = await balanceDonor();
        const balFundFDiff = await balanceFundF();
        assert.equal(balDonorDiff, neg(donationValue), "Wrong donor balance");
        assert.equal(balFundFDiff, donationValue, "Wrong fund f. balance");
      });

      it(`Should call forward and move the tokens to the bridge - tx #${i}`, async () => {
        const balanceBridg = await compareBalance(bridge.address, dai);
        const balanceFundF = await compareBalance(fundsForwarder.address, dai);

        const tx = await fundsForwarder.forward(dai.address, {
          from: claimerAccount
        });
        gasData[`Forward DAI Tokens tx #${i}`] = tx.receipt.gasUsed;
        const forwarded = getEvent(tx.logs, "Forwarded");
        assert.equal(
          forwarded.args.balance.toString(),
          donationValue,
          "Wrong balance in Forwarded event"
        );

        const balBridgDiff = await balanceBridg();
        const balFundFDiff = await balanceFundF();
        assert.equal(balBridgDiff, donationValue, "Wrong bridge balance");
        assert.equal(balFundFDiff, neg(donationValue), "Wrong fund f. balance");

        const events = await bridge.getPastEvents("allEvents", lastBlock(tx));
        const donate = getEvent(events, "Donate");
        assert.deepEqual(
          {
            giverId: donate.args.giverId.toNumber(),
            receiverId: donate.args.receiverId.toNumber(),
            token: donate.args.token,
            amount: donate.args.amount.toString()
          },
          {
            giverId,
            receiverId,
            token: dai.address,
            amount: donationValue
          },
          "Wrong event Donate arguments"
        );
      });
    }
  });

  /**
   * Multiple token forwarding
   */
  describe("Multiple token forwarding", () => {
    before("Deploy ERC20, mint and whitelist in the bridge", async () => {
      await fundsForwarder.send(donationValue, {
        from: donorAccount
      });
      await erc20.transfer(fundsForwarder.address, donationValue, {
        from: donorAccount
      });
      await dai.transfer(fundsForwarder.address, donationValue, {
        from: donorAccount
      });
    });

    it(`Should forward multiple tokens`, async () => {
      const tokens = [
        { name: "ETH", key: null, address: zeroAddress },
        { name: "ERC20", key: erc20, address: erc20.address },
        { name: "DAi", key: dai, address: dai.address }
      ];
      for (const token of tokens) {
        token.balanceBridg = await compareBalance(bridge.address, token.key);
        token.balanceFundF = await compareBalance(
          fundsForwarder.address,
          token.key
        );
      }

      const tx = await fundsForwarder.forwardMultiple(
        tokens.map(token => token.address),
        { from: claimerAccount }
      );
      gasData["Forward multiple tokens tx"] = tx.receipt.gasUsed;

      const events = await bridge.getPastEvents("allEvents", lastBlock(tx));

      for (const token of tokens) {
        const balBridgDiff = await token.balanceBridg();
        const balFundFDiff = await token.balanceFundF();
        assert.equal(balBridgDiff, donationValue, "Wrong bridge balance");
        assert.equal(balFundFDiff, neg(donationValue), "Wrong fund f. balance");
        // Check that there exists a Forwarded event
        const forwardEvent = tx.logs.find(
          event =>
            event.event === "Forwarded" && event.args.token === token.address
        );
        assert.ok(forwardEvent, `Forwarded event not found for ${token.name}`);
        // Check that there exists a Donate event
        const donateEvent = events.find(
          event =>
            event.event === "Donate" &&
            event.returnValues.token === token.address
        );
        assert.ok(donateEvent, `Donate event not found for ${token.name}`);
      }
    });
  });

  /**
   * Recovery of ETH via escapeHatch
   */

  describe("Funds recovery via escape hatch", () => {
    before(`Assert the the escapeHatch accounts are correct`, async () => {
      assert.equal(
        await fundsForwarderFactory.escapeHatchCaller(),
        escapeHatchCaller,
        "Wrong escapeHatchCaller"
      );
      assert.equal(
        await fundsForwarderFactory.escapeHatchDestination(),
        escapeHatchDestination,
        "Wrong escapeHatchDestination"
      );
    });

    it(`Should recover ETH from the fundsForwarder`, async () => {
      const balanceVault = await compareBalance(escapeHatchDestination);
      const balanceFundF = await compareBalance(fundsForwarder.address);

      await fundsForwarder.send(donationValue, {
        from: donorAccount
      });

      const balFundFDiff = await balanceFundF();
      assert.equal(balFundFDiff, donationValue, "Wrong fund f. balance");

      await fundsForwarder.escapeHatch(zeroAddress, {
        from: bossAccount
      });

      const balVaultDiff = await balanceVault();
      assert.equal(balVaultDiff, donationValue, "Wrong vault balance");
    });

    it(`Should recover tokens from the fundsForwarder`, async () => {
      await erc20.mint(donorAccount, donationValue);

      const balanceVault = await compareBalance(escapeHatchDestination, erc20);
      const balanceFundF = await compareBalance(fundsForwarder.address, erc20);

      await erc20.transfer(fundsForwarder.address, donationValue, {
        from: donorAccount
      });

      const balFundFDiff = await balanceFundF();
      assert.equal(balFundFDiff, donationValue, "Wrong fund f. balance");

      await fundsForwarder.escapeHatch(erc20.address, {
        from: bossAccount
      });

      const balVaultDiff = await balanceVault();
      assert.equal(balVaultDiff, donationValue, "Wrong vault balance");
    });

    it(`Should not allow recover tokens to non escapeHatchCaller`, async () => {
      await shouldRevertWithMessage(
        () =>
          fundsForwarder.escapeHatch(zeroAddress, {
            from: donorAccount
          }),
        "RECOVER_DISALLOWED"
      );
    });
  });

  describe("FundsForwarderFactory additional functions", () => {
    let fundsForwarderFactory2;
    it("Should change the bridge to a new address", async () => {
      const newBridgeAddress = zeroAddress;
      const tx = await fundsForwarderFactory.changeBridge(newBridgeAddress);

      const bridgeChangedEvent = getEvent(tx.logs, "BridgeChanged");
      assert.equal(
        bridgeChangedEvent.args.newBridge,
        newBridgeAddress,
        "Wrong newBridgeAddress in Bridge Changed event"
      );

      const currentBridge = await fundsForwarderFactory.bridge();
      assert.equal(
        currentBridge,
        newBridgeAddress,
        "bridge var was not set to newBridgeAddress"
      );
    });

    it("Should not let create a new FundsForwarder with a 0x0 bridge address", async () => {
      await shouldRevertWithMessage(
        () =>
          fundsForwarderFactory.newFundsForwarder(giverId, receiverId, {
            from: campaignManagerAccount
          }),
        "ERROR_BRIDGE_CALL"
      );
    });

    it("Should deploy a FundsForwarderFactory with an existing child logic", async () => {
      fundsForwarderFactory2 = await FundsForwarderFactory.new(
        bridge.address,
        escapeHatchCaller,
        escapeHatchDestination,
        fundsForwarderLogic.address
      );
      assert.equal(
        await fundsForwarderFactory2.childImplementation(),
        fundsForwarderLogic.address,
        "Child implementation was not correctly set on the constructor"
      );
    });

    it("Should change the childLogicImplementation of the FundsForwarderFactory", async () => {
      const newChildImplementation = nonContractAddress;
      fundsForwarderFactory2 = await FundsForwarderFactory.new(
        bridge.address,
        escapeHatchCaller,
        escapeHatchDestination,
        fundsForwarderLogic.address
      );

      const tx = await fundsForwarderFactory2.changeChildImplementation(
        newChildImplementation
      );

      const childImplementationChangedEvent = getEvent(
        tx.logs,
        "ChildImplementationChanged"
      );
      assert.equal(
        childImplementationChangedEvent.args.newChildImplementation,
        newChildImplementation,
        "Wrong newChildImplementation in Child Implementation Changed event"
      );

      assert.equal(
        await fundsForwarderFactory2.childImplementation(),
        newChildImplementation,
        "Child implementation was not changed"
      );
    });
  });

  describe("FundsForwarderFactory require conditions", () => {
    it("Should revert if pointing to a non contract bridge", async () => {
      await shouldRevertWithMessage(
        () =>
          FundsForwarderFactory.new(
            nonContractAddress,
            escapeHatchCaller,
            escapeHatchDestination,
            zeroAddress
          ),
        "ERROR_NOT_A_CONTRACT"
      );
    });

    it("Should revert if given an incorrent escapeHatchCaller", async () => {
      await shouldRevertWithMessage(
        () =>
          FundsForwarderFactory.new(
            bridge.address,
            nonContractAddress,
            escapeHatchDestination,
            zeroAddress
          ),
        "ERROR_HATCH_CALLER"
      );
    });

    it("Should revert if given an incorrent escapeHatchDestination", async () => {
      await shouldRevertWithMessage(
        () =>
          FundsForwarderFactory.new(
            bridge.address,
            escapeHatchCaller,
            nonContractAddress,
            zeroAddress
          ),
        "ERROR_HATCH_DESTINATION"
      );
    });
  });

  after("Get gas data", async () => {
    console.log("\nGas data\n========");
    console.table(gasData);
  });
});
