// HashtagList
const FundsForwarderFactory = artifacts.require("FundsForwarderFactory");
const FundsForwarder = artifacts.require("FundsForwarder");
const GivethBridge = artifacts.require("GivethBridge");
const ERC20Insecure = artifacts.require("ERC20Insecure");
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

contract("FundsForwarder", accounts => {
  // Accounts
  const bossAccount = accounts[0];
  const campaignManagerAccount = accounts[1];
  const donorAccount = accounts[2];
  const claimerAccount = accounts[3];
  console.log({
    bossAccount,
    campaignManagerAccount,
    donorAccount,
    claimerAccount
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

  // Giveth bridge params
  // - Shared
  const escapeHatchCaller = bossAccount;
  const escapeHatchDestination = bossAccount;
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

  before("Deploy Giveth bridge and FundsForwarderFactory", async () => {
    bridge = await GivethBridge.new(
      escapeHatchCaller,
      escapeHatchDestination,
      absoluteMinTimeLock,
      timeLock,
      securityGuard,
      maxSecurityGuardDelay
    );
    fundsForwarderFactory = await FundsForwarderFactory.new(
      bridge.address,
      escapeHatchCaller,
      escapeHatchDestination
    );
  });

  it(`campaignManager should deploy FundsForwarder via the factory`, async () => {
    const tx = await fundsForwarderFactory.newFundsForwarder(
      giverId,
      receiverId,
      { from: campaignManagerAccount }
    );

    const newFundForwarder = getEvent(tx.logs, "NewFundForwarder");
    fundsForwarder = await FundsForwarder.at(
      newFundForwarder.args.fundsForwarder
    );

    // Check that the ids are correct
    const _receiverId = await fundsForwarder.receiverId();
    const _giverId = await fundsForwarder.giverId();
    assert.equal(_receiverId, receiverId, "Wrong receiverId");
    assert.equal(_giverId, giverId, "Wrong giverId");

    // Check that the permissions are correct
    const fundsForwarderOwner = await fundsForwarder.owner();
    assert.equal(
      fundsForwarderOwner,
      bossAccount,
      "Owner of fundsForwarder should be the boss"
    );
  });

  describe("ETH donation", () => {
    it(`Should send ETH to the fundsForwarder`, async () => {
      const balanceDonor = await compareBalance(donorAccount);
      const balanceFundF = await compareBalance(fundsForwarder.address);

      const tx = await fundsForwarder.send(donationValue, {
        from: donorAccount
      });

      const gasCost = toBN(tx.receipt.gasUsed).mul(toBN(1e9));
      const txCost = donationValueBn.add(gasCost).toString();
      const balDonorDiff = await balanceDonor();
      const balFundFDiff = await balanceFundF();
      assert.equal(balDonorDiff, neg(txCost), "Wrong donor balance");
      assert.equal(balFundFDiff, donationValue, "Wrong fund f. balance");
    });

    it(`Should call forward and move the ETH to the bridge`, async () => {
      const balanceBridg = await compareBalance(bridge.address);
      const balanceFundF = await compareBalance(fundsForwarder.address);

      const tx = await fundsForwarder.forward(zeroAddress, {
        from: claimerAccount
      });
      console.log(`Forwarded ETH txHash: ${tx.tx}`);
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
      await erc20.mint(donorAccount, donationValue);
      const balance = await erc20
        .balanceOf(donorAccount)
        .then(b => b.toString());
      if (balance !== donationValue)
        throw Error(
          `Wrong donor minted balance ${balance} == ${donationValue}`
        );
      await bridge.whitelistToken(erc20.address, true);
    });

    it(`Should send tokens to the fundsForwarder`, async () => {
      const balanceDonor = await compareBalance(donorAccount, erc20);
      const balanceFundF = await compareBalance(fundsForwarder.address, erc20);

      const tx = await erc20.transfer(fundsForwarder.address, donationValue, {
        from: donorAccount
      });
      console.log(`txHash: ${tx.tx}`);

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

  // it(`Should disable the hashtag and retrieve it`, async () => {
  //   const statusBefore = await hashtagList.hashtagsStatus(hashtagAddress);
  //   await hashtagList.disableHashtag(hashtagAddress);
  //   const statusAfter = await hashtagList.hashtagsStatus(hashtagAddress);
  //   assert.equal(HashtagStatus[statusBefore], "Enabled");
  //   assert.equal(HashtagStatus[statusAfter], "Disabled");
  // });

  // it(`Should enable the hashtag and retrieve it`, async () => {
  //   const statusBefore = await hashtagList.hashtagsStatus(hashtagAddress);
  //   await hashtagList.enableHashtag(hashtagAddress);
  //   const statusAfter = await hashtagList.hashtagsStatus(hashtagAddress);
  //   assert.equal(HashtagStatus[statusBefore], "Disabled");
  //   assert.equal(HashtagStatus[statusAfter], "Enabled");
  // });

  // it(`Should retrieve the hashtags using the array and mapping`, async () => {
  //   const hashtags = await hashtagList.getHashtags();
  //   const enabled = await hashtagList.hashtagsStatus(hashtags[0]);
  //   assert.equal(Array.isArray(hashtags), true);
  //   assert.equal(hashtags.length, 1);
  //   assert.equal(enabled, 1);
  // });

  //   // Print gas used in console to know how expensive is each action
  //   after(function() {
  //     console.log({ hashtagListAddress: hashtagList.address, hashtagAddress });
  //   });
});
