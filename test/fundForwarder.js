// HashtagList
const FundsForwarderFactory = artifacts.require("FundsForwarderFactory");
const FundsForwarder = artifacts.require("FundsForwarder");
const GivethBridge = artifacts.require("GivethBridge");
const ERC20Insecure = artifacts.require("ERC20Insecure");
const InsecureDaiToken = artifacts.require("InsecureDSToken");
const assert = require("assert");
const fs = require("fs");
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
 * Removes the initial "0x"
 * @param {string} hexString
 */
const strip0x = hexString => hexString.replace("0x", "");

/**
 * Pause for `ms`
 * @param {number} ms
 */
function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
  const tokenOwnerAccount = accounts[0];
  const fundsForwarderFactoryDeployerAccount = accounts[1];
  const campaignManagerAccount = accounts[2];
  const donorAccount = accounts[3];
  const claimerAccount = accounts[4];
  const escapeHatchCaller = accounts[5];
  const escapeHatchDestination = accounts[6];
  const bridgeOwnerAccount = accounts[7];
  const safeVaultAccount = accounts[8];
  const securityGuard = accounts[9];
  console.log({
    fundsForwarderFactoryDeployerAccount,
    campaignManagerAccount,
    donorAccount,
    claimerAccount,
    escapeHatchCaller,
    escapeHatchDestination,
    bridgeOwnerAccount,
    safeVaultAccount,
    securityGuard
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
  // - Dedicated
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
        maxSecurityGuardDelay,
        { from: bridgeOwnerAccount }
      );

      // FundsForwarderFactory deployment
      fundsForwarderFactory = await FundsForwarderFactory.new(
        bridge.address,
        escapeHatchCaller,
        escapeHatchDestination,
        zeroAddress,
        { from: fundsForwarderFactoryDeployerAccount }
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

  it("FundsForwarderFactory owner should be the bridge owner", async () => {
    assert.equal(
      await fundsForwarderFactory.owner(),
      bridgeOwnerAccount,
      "on FundsForwarderFactory"
    );
    assert.equal(await bridge.owner(), bridgeOwnerAccount, "on Bridge");
  });

  it("FundsForwarderFactory escapeHatchCaller should be the bridge escapeHatchCaller", async () => {
    assert.equal(
      await fundsForwarderFactory.escapeHatchCaller(),
      escapeHatchCaller,
      "on FundsForwarderFactory"
    );
    assert.equal(
      await bridge.escapeHatchCaller(),
      escapeHatchCaller,
      "on Bridge"
    );
  });

  it("FundsForwarderFactory escapeHatchDestination should be the bridge escapeHatchDestination", async () => {
    assert.equal(
      await fundsForwarderFactory.escapeHatchDestination(),
      escapeHatchDestination,
      "on FundsForwarderFactory"
    );
    assert.equal(
      await bridge.escapeHatchDestination(),
      escapeHatchDestination,
      "on Bridge"
    );
  });

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
        "Wrong value transfered in Forwarded event"
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
      erc20 = await ERC20Insecure.new({ from: tokenOwnerAccount });
      await erc20.mint(donorAccount, maxValue, { from: tokenOwnerAccount });
      const balance = await erc20
        .balanceOf(donorAccount)
        .then(b => b.toString());
      if (balance !== maxValue)
        throw Error(`Wrong donor minted balance ${balance} == ${maxValue}`);
      await bridge.whitelistToken(erc20.address, true, {
        from: bridgeOwnerAccount
      });
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
        "Wrong value transfered in Forwarded event"
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
      dai = await InsecureDaiToken.new(web3.utils.asciiToHex("DAI", 32), {
        from: tokenOwnerAccount
      });
      await dai.mint(maxValue, { from: donorAccount });
      const balance = await dai.balanceOf(donorAccount).then(b => b.toString());
      if (balance !== maxValue)
        throw Error(`Wrong donor minted balance ${balance} == ${maxValue}`);
      await bridge.whitelistToken(dai.address, true, {
        from: bridgeOwnerAccount
      });
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
          "Wrong value transfered in Forwarded event"
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

  describe("Moloch shares forwarding", () => {
    // Define accounts, paralel to current account names
    const [
      molochSummoner,
      secondMember,
      fundingMember,
      fundsForwarderMolochMockAddress
    ] = accounts;

    // Load actual deploy tx on mainnet for fidelity
    const molochDaoDeployTxDataOriginal = fs.readFileSync(
      "test/molochDaoDeployTx.txt",
      "utf8"
    );
    const wethDeployTxDataOriginal = fs.readFileSync(
      "test/wethDeployTx.txt",
      "utf8"
    );
    const molochDaoAbi = require("./molochDaoAbi.json");
    const wethAbi = require("./wethAbi.json");

    // Current values in the MolochDAO
    const proposalDeposit = web3.utils.toWei("10", "ether");
    const processingReward = web3.utils.toWei("0.1", "ether");
    const dilutionBound = "3";
    // Custom values to speed up testing
    const periodDuration = 1;
    const votingPeriodLength = 1;
    const gracePeriodLength = 0;
    const abortWindow = 1;

    /**
     * Edits the tx data of a MolochDAO deploy modifying only
     * the constructor arguments
     *
     * @param {address} _summoner First member of the DAO
     * @param {address} _approvedToken WETH
     * @param {number} _periodDuration (seconds, >0)
     * @param {number} _votingPeriodLength Voting window (periods, >0)
     * @param {number} _gracePeriodLength Abort window (periods)
     * @param {number} _abortWindow Abort window (periods, >0)
     * @param {number} _proposalDeposit Token (>=_processingReward)
     * @param {number} _dilutionBound (>0)
     * @param {number} _processingReward Token reward to the processing person
     */
    function getMolochDaoDeployTxData({ _summoner, _approvedToken }) {
      const constructorData = web3.eth.abi.encodeParameters(
        [
          "address",
          "address",
          "uint256",
          "uint256",
          "uint256",
          "uint256",
          "uint256",
          "uint256",
          "uint256"
        ],
        [
          _summoner,
          _approvedToken,
          periodDuration,
          votingPeriodLength,
          gracePeriodLength,
          abortWindow,
          proposalDeposit,
          dilutionBound,
          processingReward
        ]
      );
      const constructorDataNo0x = constructorData.replace("0x", "");
      return (
        molochDaoDeployTxDataOriginal.slice(0, -constructorDataNo0x.length) +
        constructorDataNo0x
      );
    }

    let weth;
    let wethERC20;
    let molochDao;
    let guildBankAddress;

    before("Deploy WETH and the Moloch DAO", async () => {
      // Deploy WETH, doesn't matter who deploys it (no owner or similar)
      const wethTx = await web3.eth.sendTransaction({
        from: molochSummoner,
        data: wethDeployTxDataOriginal,
        gas: 1500000,
        gasPrice: 100000000000
      });
      weth = new web3.eth.Contract(wethAbi, wethTx.contractAddress);
      // Use to check balance
      wethERC20 = await ERC20Insecure.at(wethTx.contractAddress);
      // Whitelist token in the bridge
      await bridge.whitelistToken(wethERC20.address, true, {
        from: bridgeOwnerAccount
      });

      // Deploy Moloch DAO
      const molochDaoDeployTxData = getMolochDaoDeployTxData({
        _summoner: molochSummoner,
        _approvedToken: wethTx.contractAddress
      });

      const molochTx = await web3.eth.sendTransaction({
        from: molochSummoner,
        data: molochDaoDeployTxData,
        gas: 5685070,
        gasPrice: 100000000000
      });
      molochDao = new web3.eth.Contract(molochDaoAbi, molochTx.contractAddress);
      guildBankAddress = await molochDao.methods.guildBank().call();
    });

    /**
     * [HELPER] method to deposit and approve to WETH
     * @param {string} from
     * @param {string} value
     */
    async function depositAndApprove(from, value) {
      await weth.methods.deposit().send({ from, value });
      await weth.methods.approve(molochDao._address, value).send({ from });
    }

    /**
     * [HELPER] Get the total shares of the deployed Moloch DAO
     */
    async function getTotalShares() {
      return await molochDao.methods.totalShares().call();
    }

    /**
     * [HELPER] Get the balance of an account on the deployed WETH
     * @param {string} from
     */
    async function getWethBalance(from) {
      return await weth.methods.balanceOf(from).call();
    }

    /**
     * [HELPER] Completes the onboarding flow on the deployed Moloch DAO
     * - Submit a proposal
     * - Vote Yes on it
     * - Process the proposal to mint shares to the new member
     * @param {string} newMemberAddress "0x..."
     * @param {string} tokenTribute "10000000000000"
     * @param {number} sharesRequested 100
     */
    async function completeNewMemberProposal(
      newMemberAddress,
      tokenTribute,
      sharesRequested
    ) {
      await depositAndApprove(molochSummoner, proposalDeposit);

      // Should submit a proposal for a second member
      const submitProposalTx = await molochDao.methods
        .submitProposal(
          newMemberAddress, // applicant
          tokenTribute, // tokenTribute
          sharesRequested, // sharesRequested
          "Applicant Name" // details
        )
        .send({ from: molochSummoner, gas: 1500000 });

      const submitProposalEvent = submitProposalTx.events.SubmitProposal;
      if (!submitProposalEvent) throw Error("No SubmitProposal event");
      const proposalIndex = submitProposalEvent.returnValues.proposalIndex;

      // Should submit vote yes on the member proposal
      let success = false;
      while (!success) {
        await pause(500);
        try {
          // uintVote, Yes: 1
          await molochDao.methods
            .submitVote(proposalIndex, 1)
            .send({ from: molochSummoner, gas: 1500000 });
          success = true;
        } catch (e) {
          // Wait and retry only if it reverted because the vote hasn't started
          if (!e.message.includes("voting period has not started")) throw e;
        }
      }

      // Should process proposal for the second member
      await pause(1000);

      const processProposalTx = await molochDao.methods
        .processProposal(proposalIndex)
        .send({ from: molochSummoner, gas: 1500000 });

      const processProposalEvent = processProposalTx.events.ProcessProposal;
      if (!processProposalEvent) throw Error("No ProcessProposal event");
      assert.ok(
        processProposalEvent.returnValues.didPass,
        "Proposal did not pass"
      );
    }

    describe("Test a normal user flow on the MolochDAO", () => {
      const tokenTribute = web3.utils.toWei("100", "ether");
      // Sub 1 share to compensate the summoner, to get round numbers
      const sharesRequested = 100 - 1;
      before("Get tokens", async () => {
        // Mint and approve WETH first
        await depositAndApprove(secondMember, tokenTribute);
      });

      it("Should complete a new member proposal", async () => {
        await completeNewMemberProposal(
          secondMember,
          tokenTribute,
          sharesRequested
        );
      });

      it("Second member should ragequit", async () => {
        await molochDao.methods
          .ragequit(sharesRequested)
          .send({ from: secondMember, gas: 1500000 });
      });
    });

    describe("Grant shares to a FundsForwarder and then forward the underlying token", () => {
      /**
       * The only way to take money out of the Moloch DAO is calling
       * `MolochDAO.ragequit(sharesToBurn)`
       * which would call
       * `guildBank.withdraw(msg.sender)`
       * and in order for that to work
       * `members[msg.sender].shares >= sharesToBurn`
       *
       * The members map is modified on processProposal where
       * `members[proposal.applicant] = new Member()`
       *
       * The applicant is defined when on submitProposal where it has to:
       * - `!= address(0)`
       * - `approvedToken.transferFrom(applicant, address(this), tokenTribute)`
       *
       * The WETH token contract would consider a successful transferFrom when
       * the from has 0 tokens if the amount transfered is also 0.
       */

      const requesting = {
        tokenTribute: 0,
        sharesRequested: 10
      };
      const funding = {
        tokenTribute: web3.utils.toWei(String(5000 - 1), "ether"),
        // Sub 1 share to compensate the summoner, to get round numbers
        sharesRequested: 500 - 1 - requesting.sharesRequested
      };
      // Resulting transfer for shares requested
      // Computed from the minting and burning of shares
      const wethTransf = web3.utils.toWei(String(100), "ether");

      before("Add funds to the Moloch DAO", async () => {
        // Mint and approve WETH first
        await depositAndApprove(fundingMember, funding.tokenTribute);
        // Add funds to the Moloch DAO with a new member
        await completeNewMemberProposal(
          fundingMember,
          funding.tokenTribute,
          funding.sharesRequested
        );
      });

      it("Should submit a proposal for a FundsForwarder contract", async () => {
        await completeNewMemberProposal(
          fundsForwarder.address,
          requesting.tokenTribute,
          requesting.sharesRequested
        );
      });

      it("Should forward the funds with a ragequit", async () => {
        const totalSharesBefore = await getTotalShares();
        const balanceGuild = await compareBalance(guildBankAddress, wethERC20);
        const balanceBridg = await compareBalance(bridge.address, wethERC20);
        const balanceFundF = await compareBalance(
          fundsForwarder.address,
          wethERC20
        );

        const tx = await fundsForwarder.forwardMoloch(molochDao._address, {
          from: claimerAccount
        });
        gasData["Forward Moloch DAO shares (WETH)"] = tx.receipt.gasUsed;
        const forwarded = getEvent(tx.logs, "Forwarded");
        assert.equal(
          forwarded.args.balance.toString(),
          wethTransf,
          "Wrong value transfered in Forwarded event"
        );

        // 10 shares should be burned as they are requested by the requester
        const totalSharesDiff = (await getTotalShares()) - totalSharesBefore;
        const balGuildDiff = await balanceGuild();
        const balBridgDiff = await balanceBridg();
        const balFundFDiff = await balanceFundF();
        assert.equal(totalSharesDiff, -10, "Wrong total shares diff");
        assert.equal(balGuildDiff, neg(wethTransf), "Wrong guild bank balance");
        assert.equal(balBridgDiff, wethTransf, "Wrong bridge balance");
        assert.equal(balFundFDiff, "0", "Wrong fund f. balance");

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
            token: wethERC20.address,
            amount: wethTransf
          },
          "Wrong event Donate arguments"
        );
      });
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
        from: escapeHatchCaller
      });

      const balVaultDiff = await balanceVault();
      assert.equal(balVaultDiff, donationValue, "Wrong vault balance");
    });

    it(`Should recover tokens from the fundsForwarder`, async () => {
      await erc20.mint(donorAccount, donationValue, {
        from: tokenOwnerAccount
      });

      const balanceVault = await compareBalance(escapeHatchDestination, erc20);
      const balanceFundF = await compareBalance(fundsForwarder.address, erc20);

      await erc20.transfer(fundsForwarder.address, donationValue, {
        from: donorAccount
      });

      const balFundFDiff = await balanceFundF();
      assert.equal(balFundFDiff, donationValue, "Wrong fund f. balance");

      await fundsForwarder.escapeHatch(erc20.address, {
        from: escapeHatchCaller
      });

      const balVaultDiff = await balanceVault();
      assert.equal(balVaultDiff, donationValue, "Wrong vault balance");
    });

    it(`Should not allow recover tokens to non escapeHatchCaller`, async () => {
      await shouldRevertWithMessage(
        () =>
          fundsForwarder.escapeHatch(zeroAddress, {
            from: fundsForwarderFactoryDeployerAccount
          }),
        "RECOVER_DISALLOWED"
      );

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
    const newBridgeAddress = zeroAddress;
    const newChildImplementation = nonContractAddress;

    it("Should change the bridge to a new address", async () => {
      const tx = await fundsForwarderFactory.changeBridge(newBridgeAddress, {
        from: bridgeOwnerAccount
      });

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

    it("Should not allow the fundsForwarderFactory deployer to change the bridge address", async () => {
      await shouldRevertWithMessage(
        () =>
          fundsForwarderFactory.changeBridge(newBridgeAddress, {
            from: fundsForwarderFactoryDeployerAccount
          }),
        "err_escapableInvalidCaller"
      );
    });

    it("Should not let create a new FundsForwarder with a 0x0 bridge address", async () => {
      assert.equal(
        await fundsForwarderFactory.bridge(),
        zeroAddress,
        "bridge address must be 0x0"
      );
      await shouldRevertWithMessage(
        () =>
          fundsForwarderFactory.newFundsForwarder(giverId, receiverId, {
            from: campaignManagerAccount
          }),
        "ERROR_ZERO_BRIDGE"
      );
    });

    it("Should not let to forward with a 0x0 bridge address", async () => {
      assert.equal(
        await fundsForwarderFactory.bridge(),
        zeroAddress,
        "bridge address must be 0x0"
      );
      await shouldRevertWithMessage(
        () =>
          fundsForwarder.forward(zeroAddress, {
            from: claimerAccount
          }),
        "ERROR_ZERO_BRIDGE"
      );
    });

    it("Should deploy a FundsForwarderFactory with an existing child logic", async () => {
      fundsForwarderFactory2 = await FundsForwarderFactory.new(
        bridge.address,
        escapeHatchCaller,
        escapeHatchDestination,
        fundsForwarderLogic.address,
        { from: fundsForwarderFactoryDeployerAccount }
      );
      assert.equal(
        await fundsForwarderFactory2.childImplementation(),
        fundsForwarderLogic.address,
        "Child implementation was not correctly set on the constructor"
      );
    });

    it("Should change the childLogicImplementation of the FundsForwarderFactory", async () => {
      const tx = await fundsForwarderFactory2.changeChildImplementation(
        newChildImplementation,
        { from: bridgeOwnerAccount }
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

    it("Should not allow the fundsForwarderFactory deployer to change the childLogicImplementation address", async () => {
      await shouldRevertWithMessage(
        () =>
          fundsForwarderFactory.changeChildImplementation(
            newChildImplementation,
            { from: fundsForwarderFactoryDeployerAccount }
          ),
        "err_escapableInvalidCaller"
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
            zeroAddress,
            { from: fundsForwarderFactoryDeployerAccount }
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
            zeroAddress,
            { from: fundsForwarderFactoryDeployerAccount }
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
            zeroAddress,
            { from: fundsForwarderFactoryDeployerAccount }
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
