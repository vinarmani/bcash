/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const consensus = require('../lib/protocol/consensus');
const Coin = require('../lib/primitives/coin');
const Script = require('../lib/script/script');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const MTX = require('../lib/primitives/mtx');
const MemWallet = require('./util/memwallet');
const Network = require('../lib/protocol/network');
const Output = require('../lib/primitives/output');
const common = require('../lib/blockchain/common');
const util = require('../lib/utils/util');
const nodejsUtil = require('util');
const Opcode = require('../lib/script/opcode');
const BlockStore = require('../lib/blockstore/level');
const opcodes = Script.opcodes;

const ZERO_KEY = Buffer.alloc(33, 0x00);

const ONE_HASH = Buffer.alloc(32, 0x00);
ONE_HASH[0] = 0x01;

const network = Network.get('regtest');

const workers = new WorkerPool({
  enabled: true,
  size: 2
});


const blocks = new BlockStore({
  memory: true,
  network
});

const chain = new Chain({
  memory: true,
  blocks,
  network,
  workers
});

const miner = new Miner({
  chain,
  version: 4,
  workers
});

const cpu = miner.cpu;

const wallet = new MemWallet({
  network
});

const GRAVITON = util.now() + 10;

let tip1 = null;
let tip2 = null;

async function addBlock(block, flags) {
  let entry;

  try {
    entry = await chain.add(block, flags);
  } catch (e) {
    assert.strictEqual(e.type, 'VerifyError');
    return e.reason;
  }

  if (!entry)
    return 'bad-prevblk';

  return 'OK';
}

async function mineBlock(job, flags) {
  const block = await job.mineAsync();
  return await addBlock(block, flags);
}

async function mineCSV(fund) {
  const job = await cpu.createJob();
  const spend = new MTX();

  spend.addOutput({
    script: [
      Opcode.fromInt(1),
      Opcode.fromSymbol('checksequenceverify')
    ],
    value: 10000
  });

  spend.addTX(fund, 0);
  spend.setLocktime(chain.height);

  wallet.sign(spend);

  const [tx, view] = spend.commit();

  job.addTX(tx, view);
  job.refresh();

  return await job.mineAsync();
}

/*
 * @param {Number} size - Expected tx size
 * @param {Boolean} [pushonly=false]
 * @param {Boolean} [cleanstack=false]
 * @returns {[MTX, MTX]} - Returns fund tx and desired tx.
 */

async function spendTX(size, pushonly, cleanstack) {
  const fundTX = new MTX();

  fundTX.addOutput({
    script: [Opcode.fromOp(opcodes.OP_1)], // OP_TRUE
    value: 0
  });

  await wallet.fund(fundTX);
  wallet.sign(fundTX);

  const extraOps = [];

  if (pushonly === false) {
    extraOps.push(
      Opcode.fromOp(opcodes.OP_1),
      Opcode.fromOp(opcodes.OP_DROP)
    );
  }

  if (cleanstack === false)
    extraOps.push(Opcode.fromOp(opcodes.OP_1));

  const spend = new MTX();

  // first one is our output (BIP69 sorted)
  spend.addTX(fundTX, 0);

  for (const op of extraOps)
    spend.inputs[0].script.push(op);

  spend.inputs[0].script.compile();

  spend.addOutput({
    script: [Opcode.fromOp(opcodes.OP_RETURN)],
    value: 0
  });

  const txSize = spend.getSize();
  const fillSize = size - txSize - 1;

  if (fillSize > 0) {
    spend.outputs[0].script.pushData(random.randomBytes(fillSize));
    spend.outputs[0].script.compile();
  }

  return [fundTX, spend];
}

chain.on('connect', (entry, block) => {
  wallet.addBlock(entry, block.txs);
});

chain.on('disconnect', (entry, block) => {
  wallet.removeBlock(entry, block.txs);
});

describe('Chain', function() {
  this.timeout(process.browser ? 1200000 : 60000);

  before(async() => {
    await blocks.open();
    await chain.open();
    await miner.open();
    await workers.open();

    miner.addresses.length = 0;
    miner.addAddress(wallet.getReceive());
  });

  after(async () => {
    await workers.close();
    await miner.close();
    await chain.close();
    await blocks.close();
  });

  it('should mine 200 blocks', async () => {
    for (let i = 0; i < 200; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }

    assert.strictEqual(chain.height, 200);
  });

  it('should mine competing chains', async () => {
    for (let i = 0; i < 10; i++) {
      const job1 = await cpu.createJob(tip1);
      const job2 = await cpu.createJob(tip2);

      const mtx = await wallet.create({
        outputs: [{
          address: wallet.getAddress(),
          value: 10 * 1e8
        }]
      });

      job1.addTX(mtx.toTX(), mtx.view);
      job2.addTX(mtx.toTX(), mtx.view);

      job1.refresh();
      job2.refresh();

      const blk1 = await job1.mineAsync();
      const blk2 = await job2.mineAsync();

      const hash1 = blk1.hash();
      const hash2 = blk2.hash();

      assert(await chain.add(blk1));
      assert(await chain.add(blk2));

      assert.bufferEqual(chain.tip.hash, hash1);

      tip1 = await chain.getEntry(hash1);
      tip2 = await chain.getEntry(hash2);

      assert(tip1);
      assert(tip2);

      assert(!await chain.isMainChain(tip2));
    }
  });

  it('should have correct chain value', () => {
    assert.strictEqual(chain.db.state.value, 897500000000);
    assert.strictEqual(chain.db.state.coin, 220);
    assert.strictEqual(chain.db.state.tx, 221);
  });

  it('should have correct wallet balance', async () => {
    assert.strictEqual(wallet.balance, 897500000000);
  });

  it('should handle a reorg', async () => {
    assert.strictEqual(chain.height, 210);

    const entry = await chain.getEntry(tip2.hash);
    assert(entry);
    assert.strictEqual(chain.height, entry.height);

    const block = await cpu.mineBlock(entry);
    assert(block);

    let forked = false;
    chain.once('reorganize', () => {
      forked = true;
    });

    assert(await chain.add(block));

    assert(forked);
    assert.bufferEqual(chain.tip.hash, block.hash());
    assert(chain.tip.chainwork.gt(tip1.chainwork));
  });

  it('should have correct chain value', () => {
    assert.strictEqual(chain.db.state.value, 900000000000);
    assert.strictEqual(chain.db.state.coin, 221);
    assert.strictEqual(chain.db.state.tx, 222);
  });

  it('should have correct wallet balance', async () => {
    assert.strictEqual(wallet.balance, 900000000000);
  });

  it('should check main chain', async () => {
    const result = await chain.isMainChain(tip1);
    assert(!result);
  });

  it('should mine a block after a reorg', async () => {
    const block = await cpu.mineBlock();

    assert(await chain.add(block));

    const hash = block.hash();
    const entry = await chain.getEntry(hash);

    assert(entry);
    assert.bufferEqual(chain.tip.hash, entry.hash);

    const result = await chain.isMainChain(entry);
    assert(result);
  });

  it('should prevent double spend on new chain', async () => {
    const mtx = await wallet.create({
      outputs: [{
        address: wallet.getAddress(),
        value: 10 * 1e8
      }]
    });

    {
      const job = await cpu.createJob();

      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    }

    {
      const job = await cpu.createJob();

      assert(mtx.outputs.length > 1);
      mtx.outputs.pop();

      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      assert.strictEqual(await mineBlock(job),
        'bad-txns-inputs-missingorspent');
    }
  });

  it('should fail to connect coins on an alternate chain', async () => {
    const block = await chain.getBlock(tip1.hash);
    const cb = block.txs[0];
    const mtx = new MTX();

    mtx.addTX(cb, 0);
    mtx.addOutput(wallet.getAddress(), 10 * 1e8);

    wallet.sign(mtx);

    const job = await cpu.createJob();
    job.addTX(mtx.toTX(), mtx.view);
    job.refresh();

    assert.strictEqual(await mineBlock(job), 'bad-txns-inputs-missingorspent');
  });

  it('should have correct chain value', () => {
    assert.strictEqual(chain.db.state.value, 905000000000);
    assert.strictEqual(chain.db.state.coin, 224);
    assert.strictEqual(chain.db.state.tx, 225);
  });

  it('should get coin', async () => {
    const mtx = await wallet.send({
      outputs: [
        {
          address: wallet.getAddress(),
          value: 1e8
        },
        {
          address: wallet.getAddress(),
          value: 1e8
        },
        {
          address: wallet.getAddress(),
          value: 1e8
        }
      ]
    });

    const job = await cpu.createJob();
    job.addTX(mtx.toTX(), mtx.view);
    job.refresh();

    const block = await job.mineAsync();
    assert(await chain.add(block));

    const tx = block.txs[1];
    const output = Coin.fromTX(tx, 2, chain.height);

    const coin = await chain.getCoin(tx.hash(), 2);

    assert.bufferEqual(coin.toRaw(), output.toRaw());
  });

  it('should have correct wallet balance', async () => {
    assert.strictEqual(wallet.balance, 907500000000);
    assert.strictEqual(wallet.receiveDepth, 15);
    assert.strictEqual(wallet.changeDepth, 14);
    assert.strictEqual(wallet.txs, 226);
  });

  it('should get tips and remove chains', async () => {
    {
      const tips = await chain.db.getTips();

      let index = -1;

      for (let i = 0; i < tips.length; i++) {
        if (tips[i].equals(chain.tip.hash))
          index = i;
      }

      assert.notStrictEqual(index, -1);
      assert.strictEqual(tips.length, 2);
    }

    await chain.db.removeChains();

    {
      const tips = await chain.db.getTips();

      let index = -1;

      for (let i = 0; i < tips.length; i++) {
        if (tips[i].equals(chain.tip.hash))
          index = i;
      }

      assert.notStrictEqual(index, -1);
      assert.strictEqual(tips.length, 1);
    }
  });

  it('should rescan for transactions', async () => {
    let total = 0;

    await chain.scan(0, wallet.filter, async (block, txs) => {
      total += txs.length;
    });

    assert.strictEqual(total, 226);
  });

  it('should activate csv', async () => {
    const deployments = network.deployments;

    miner.options.version = -1;

    assert.strictEqual(chain.height, 214);

    const prev = await chain.getPrevious(chain.tip);
    const state = await chain.getState(prev, deployments.csv);
    assert.strictEqual(state, 1);

    for (let i = 0; i < 417; i++) {
      const block = await cpu.mineBlock();
      assert(await chain.add(block));
      switch (chain.height) {
        case 288: {
          const prev = await chain.getPrevious(chain.tip);
          const state = await chain.getState(prev, deployments.csv);
          assert.strictEqual(state, 1);
          break;
        }
        case 432: {
          const prev = await chain.getPrevious(chain.tip);
          const state = await chain.getState(prev, deployments.csv);
          assert.strictEqual(state, 2);
          break;
        }
        case 576: {
          const prev = await chain.getPrevious(chain.tip);
          const state = await chain.getState(prev, deployments.csv);
          assert.strictEqual(state, 3);
          break;
        }
      }
    }

    assert.strictEqual(chain.height, 631);
    assert(chain.state.hasCSV());

    const cache = await chain.db.getStateCache();
    assert.deepStrictEqual(cache, chain.db.stateCache);
    assert.strictEqual(chain.db.stateCache.updates.length, 0);
    assert(await chain.db.verifyDeployments());
  });

  it('should test csv', async () => {
    const tx = (await chain.getBlock(chain.height - 100)).txs[0];
    const csvBlock = await mineCSV(tx);

    assert(await chain.add(csvBlock));

    const csv = csvBlock.txs[1];

    const spend = new MTX();

    spend.addOutput({
      script: [
        Opcode.fromInt(2),
        Opcode.fromSymbol('checksequenceverify')
      ],
      value: 10000
    });

    spend.addTX(csv, 0);
    spend.setSequence(0, 1, false);

    const job = await cpu.createJob();

    job.addTX(spend.toTX(), spend.view);
    job.refresh();

    const block = await job.mineAsync();

    assert(await chain.add(block));
  });

  it('should fail csv with bad sequence', async () => {
    const csv = (await chain.getBlock(chain.height - 100)).txs[0];
    const spend = new MTX();

    spend.addOutput({
      script: [
        Opcode.fromInt(1),
        Opcode.fromSymbol('checksequenceverify')
      ],
      value: 1 * 1e8
    });

    spend.addTX(csv, 0);
    spend.setSequence(0, 1, false);

    const job = await cpu.createJob();
    job.addTX(spend.toTX(), spend.view);
    job.refresh();

    assert.strictEqual(await mineBlock(job),
      'mandatory-script-verify-flag-failed');
  });

  it('should mine a block', async () => {
    const block = await cpu.mineBlock();
    assert(block);
    assert(await chain.add(block));
  });

  it('should fail csv lock checks', async () => {
    const tx = (await chain.getBlock(chain.height - 100)).txs[0];
    const csvBlock = await mineCSV(tx);

    assert(await chain.add(csvBlock));

    const csv = csvBlock.txs[1];

    const spend = new MTX();

    spend.addOutput({
      script: [
        Opcode.fromInt(2),
        Opcode.fromSymbol('checksequenceverify')
      ],
      value: 1 * 1e8
    });

    spend.addTX(csv, 0);
    spend.setSequence(0, 2, false);

    const job = await cpu.createJob();
    job.addTX(spend.toTX(), spend.view);
    job.refresh();

    assert.strictEqual(await mineBlock(job), 'bad-txns-nonfinal');
  });

  it('should have correct wallet balance', async () => {
    assert.strictEqual(wallet.balance, 1412499980000);
  });

  it('should fail to connect bad bits', async () => {
    const job = await cpu.createJob();
    job.attempt.bits = 553713663;
    assert.strictEqual(await mineBlock(job), 'bad-diffbits');
  });

  it('should fail to connect bad MTP', async () => {
    const mtp = await chain.getMedianTime(chain.tip);
    const job = await cpu.createJob();
    job.attempt.time = mtp - 1;
    assert.strictEqual(await mineBlock(job), 'time-too-old');
  });

  it('should fail to connect bad time', async () => {
    const job = await cpu.createJob();
    const now = network.now() + 3 * 60 * 60;
    job.attempt.time = now;
    assert.strictEqual(await mineBlock(job), 'time-too-new');
  });

  it('should fail to connect bad locktime', async () => {
    const job = await cpu.createJob();
    const tx = await wallet.send({ locktime: 100000 });
    job.pushTX(tx.toTX());
    job.refresh();
    assert.strictEqual(await mineBlock(job), 'bad-txns-nonfinal');
  });

  it('should fail to connect bad cb height', async () => {
    const bip34height = network.block.bip34height;
    const job = await cpu.createJob();

    job.attempt.height = 10;
    job.attempt.refresh();

    try {
      network.block.bip34height = 0;
      assert.strictEqual(await mineBlock(job), 'bad-cb-height');
    } finally {
      network.block.bip34height = bip34height;
    }
  });

  it('should mine 2000 blocks', async () => {
    for (let i = 0; i < 2001; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }

    assert.strictEqual(chain.height, 2636);
  });

  if (process.browser)
    return;

  it('should fail to connect oversized block', async () => {
    const start = chain.height - 2000;
    const end = chain.height - 200;
    const job = await cpu.createJob();

    const outputSize = 34;

    let size = 0;

    for (let i = start; i <= end; i++) {
      const block = await chain.getBlock(i);
      const cb = block.txs[0];

      const mtx = new MTX();
      mtx.addTX(cb, 0);

      const reward = consensus.getReward(i, network.halvingInterval);
      const txSize = mtx.getSize();
      const outputs = Math.min(
        Math.floor((consensus.MAX_TX_SIZE - txSize - 107) / outputSize),
        reward
      );

      for (let j = 0; j < outputs; j++)
        mtx.addOutput(wallet.getAddress(), 1);

      size += mtx.getSize();

      wallet.sign(mtx);

      job.pushTX(mtx.toTX());

      if (size >= consensus.MAX_FORK_BLOCK_SIZE)
        break;
    }

    job.refresh();

    assert.strictEqual(await mineBlock(job), 'bad-blk-length');
  });

  it('should mine a big block', async () => {
    const oldMaxForkBlockSize = consensus.MAX_FORK_BLOCK_SIZE;
    consensus.MAX_FORK_BLOCK_SIZE = 4000000;

    const OPRETURN = Script.fromNulldata(Buffer.alloc(70, 1));
    const start = chain.height - 2000;
    const end = chain.height - 200;
    const job = await cpu.createJob();
    const maxSigops = consensus.maxBlockSigops(consensus.MAX_FORK_BLOCK_SIZE);
    const perTxSigops = Math.floor((maxSigops - 1000) / 1801) - 2;
    const perTxSize = Math.floor(consensus.MAX_FORK_BLOCK_SIZE / 1801);

    const mtx = new MTX();

    const fillSize = perTxSize - (51 + 107 + (perTxSigops * 34));
    const opreturns = Math.floor(fillSize / 81);

    for (let j = 0; j < perTxSigops; j++)
      mtx.addOutput(wallet.getReceive(), 1);

    for (let j = 0; j < opreturns; j++)
      mtx.addOutput({ script: OPRETURN });

    // fill max tx
    // with 1801 transactions,
    // limits sigops to maxSigops for a block
    // and calculates expected tx size for each one
    // that is filled with OP_RETURN

    // consensus size: 117 bytes
    for (let i = start; i <= end; i++) {
      const block = await chain.getBlock(i);
      const cb = block.txs[0]; // 117 bytes

      const mtxi = mtx.clone();
      mtxi.addTX(cb, 0); // 51 bytes
      wallet.sign(mtxi); // 107 bytes
      job.pushTX(mtxi.toTX());
    }

    job.refresh();

    assert.strictEqual(await mineBlock(job), 'OK');

    consensus.MAX_FORK_BLOCK_SIZE = oldMaxForkBlockSize;
  });

  it('should fail to connect bad versions', async () => {
    for (let i = 0; i <= 3; i++) {
      const job = await cpu.createJob();
      job.attempt.version = i;
      assert.strictEqual(await mineBlock(job), 'bad-version');
    }
  });

  it('should fail to connect bad amount', async () => {
    const job = await cpu.createJob();

    job.attempt.fees += 1;
    job.refresh();
    assert.strictEqual(await mineBlock(job), 'bad-cb-amount');
  });

  it('should fail to connect premature cb spend', async () => {
    const job = await cpu.createJob();
    const block = await chain.getBlock(chain.height - 98);
    const cb = block.txs[0];
    const mtx = new MTX();

    mtx.addTX(cb, 0);
    mtx.addOutput(wallet.getAddress(), 1);

    wallet.sign(mtx);

    job.addTX(mtx.toTX(), mtx.view);
    job.refresh();

    assert.strictEqual(await mineBlock(job),
      'bad-txns-premature-spend-of-coinbase');
  });

  it('should fail to connect vout belowout', async () => {
    const job = await cpu.createJob();
    const block = await chain.getBlock(chain.height - 99);
    const cb = block.txs[0];
    const mtx = new MTX();

    mtx.addTX(cb, 0);
    mtx.addOutput(wallet.getAddress(), 1e8);

    wallet.sign(mtx);

    job.pushTX(mtx.toTX());
    job.refresh();

    assert.strictEqual(await mineBlock(job),
      'bad-txns-in-belowout');
  });

  it('should fail to connect outtotal toolarge', async () => {
    const job = await cpu.createJob();
    const block = await chain.getBlock(chain.height - 99);
    const cb = block.txs[0];
    const mtx = new MTX();

    mtx.addTX(cb, 0);

    const value = Math.floor(consensus.MAX_MONEY / 2);

    mtx.addOutput(wallet.getAddress(), value);
    mtx.addOutput(wallet.getAddress(), value);
    mtx.addOutput(wallet.getAddress(), value);

    wallet.sign(mtx);

    job.pushTX(mtx.toTX());
    job.refresh();

    assert.strictEqual(await mineBlock(job),
      'bad-txns-txouttotal-toolarge');
  });

  it('should mine 111 multisig blocks', async () => {
    const flags = common.flags.DEFAULT_FLAGS & ~common.flags.VERIFY_POW;

    const redeem = new Script();
    redeem.pushInt(20);

    for (let i = 0; i < 20; i++)
      redeem.pushData(ZERO_KEY);

    redeem.pushInt(20);
    redeem.pushOp(opcodes.OP_CHECKMULTISIG);

    redeem.compile();

    const script = Script.fromScripthash(redeem.hash160());

    for (let i = 0; i < 111; i++) {
      const block = await cpu.mineBlock();
      const cb = block.txs[0];
      const val = cb.outputs[0].value;

      cb.outputs[0].value = 0;

      for (let j = 0; j < Math.min(100, val); j++) {
        const output = new Output();
        output.script = script.clone();
        output.value = 1;

        cb.outputs.push(output);
      }

      block.refresh(true);
      block.merkleRoot = block.createMerkleRoot();

      assert(await chain.add(block, flags));
    }

    assert.strictEqual(chain.height, 2748);
  });

  it('should fail to connect too many sigops', async () => {
    const start = chain.height - 110;
    const end = chain.height - 100;
    const job = await cpu.createJob();

    const script = new Script();

    script.pushInt(20);

    for (let i = 0; i < 20; i++)
      script.pushData(ZERO_KEY);

    script.pushInt(20);
    script.pushOp(opcodes.OP_CHECKMULTISIG);

    script.compile();

    for (let i = start; i <= end; i++) {
      const block = await chain.getBlock(i);
      const cb = block.txs[0];

      if (cb.outputs.length === 2)
        continue;

      const mtx = new MTX();

      for (let j = 2; j < cb.outputs.length; j++) {
        mtx.addTX(cb, j);
        mtx.inputs[j - 2].script.fromItems([script.toRaw()]);
      }

      mtx.addOutput(wallet.getAddress(), 1);
      job.pushTX(mtx.toTX());
    }

    job.refresh();

    assert.strictEqual(await mineBlock(job), 'bad-blk-sigops');
  });

  it('should fail to connect block with too many sigops in tx', async () => {
    const job = await cpu.createJob();
    const block = await chain.getBlock(chain.height - 110);

    // create big transactions
    // to have block bigger than 1 MB (20k sigop per MB limit)
    const cb = block.txs[0];
    for (let i = 2; i < 4; i++) {
      const mtx = new MTX();

      mtx.addTX(cb, i);
      mtx.addOutput(wallet.getAddress(), 1);

      const nulldataOutput = new Output();
      const nulldataScript = nulldataOutput.script;

      nulldataScript.pushOp(opcodes.OP_RETURN);
      // half mb
      nulldataScript.pushData(Buffer.alloc(2 ** 19));
      nulldataScript.compile();

      mtx.addOutput(nulldataOutput);

      job.pushTX(mtx.toTX());
    }

    // create tx with more than 20k+ sigops
    const mtx = new MTX();

    mtx.addTX(block.txs[0], 4);

    const output = new Output();
    const script = output.script;

    for (let i = 0; i < consensus.MAX_TX_SIGOPS; i++)
      script.pushOp(opcodes.OP_CHECKSIG);

    // one more
    script.pushOp(opcodes.OP_CHECKSIG);

    script.compile();

    mtx.addOutput(output);

    job.pushTX(mtx.toTX());
    job.refresh();

    assert.strictEqual(await mineBlock(job), 'bad-txn-sigops');
  });

  it('should activate Graviton', async () => {
    const network = chain.network;

    const mtp = await chain.getMedianTime(chain.tip);

    // modify activation time for test
    network.block.gravitonActivationTime = GRAVITON;
    assert.strictEqual(chain.state.hasGraviton(), false);

    // make sure we have MTP is more than activationTime
    for (let i = 0; i < consensus.MEDIAN_TIMESPAN >>> 1; i++) {
      const block = await cpu.mineBlock();
      assert(await chain.add(block));
    }

    assert.strictEqual(chain.state.hasGraviton(), true);
  });

  it('should not mine block with tx smaller than MIN_TX_SIZE', async () => {
    // Send some money to script
    const [fund, spend] = await spendTX(consensus.MIN_TX_SIZE - 1, true, true);
    const job = await cpu.createJob();

    // push fund tx
    job.pushTX(fund.toTX(), fund.view);
    job.pushTX(spend.toTX(), spend.view);
    job.sort();
    job.refresh();

    assert.strictEqual(await mineBlock(job), 'bad-txns-undersize');
  });

  it('should not mine block without cleanstack', async () => {
    // create tx failing with cleanstack
    const [fund, spend] = await spendTX(consensus.MIN_TX_SIZE, true, false);

    const job = await cpu.createJob();

    job.pushTX(fund.toTX(), fund.view);
    job.pushTX(spend.toTX(), spend.view);
    job.sort();
    job.refresh();

    assert.strictEqual(await mineBlock(job),
      'mandatory-script-verify-flag-failed');
  });

  it('should not mine block with non-pushonly opcodes', async () => {
    // create tx failing with pushonly
    const [fund, spend] = await spendTX(consensus.MIN_TX_SIZE, false, true);

    const job = await cpu.createJob();

    job.pushTX(fund.toTX(), fund.view);
    job.pushTX(spend.toTX(), spend.view);
    job.sort();
    job.refresh();

    assert.strictEqual(await mineBlock(job),
      'mandatory-script-verify-flag-failed');
  });

  it('should mine tx of size MIN_TX_SIZE', async () => {
    const [fund, spend] = await spendTX(consensus.MIN_TX_SIZE, true, true);
    const job = await cpu.createJob();

    job.pushTX(fund.toTX(), fund.view);
    job.pushTX(spend.toTX(), spend.view);
    job.sort();
    job.refresh();

    assert.strictEqual(await mineBlock(job), 'OK');
  });

  it('should not accept non-sorted block', async () => {
    const txs = await spendTX(200, true, true);
    const job = await cpu.createJob();

    // sort in reverse order
    txs.sort((a, b) => a.txid() > b.txid() ? -1 : 1);

    for (const tx of txs)
      job.pushTX(tx.toTX(), tx.view);

    job.refresh();

    assert.strictEqual(await mineBlock(job), 'tx-ordering');
  });

  it('should mine sorted block', async () => {
    const tip = chain.tip;
    const job = await cpu.createJob();

    for (let i = 0; i < 10; i++) {
      const txs = await spendTX(200, true, true);

      job.pushTX(txs[0].toTX(), txs[0].view);
      job.pushTX(txs[1].toTX(), txs[1].view);

      // make sure we don't reuse coins.
      wallet.addTX(txs[0]);
      wallet.addTX(txs[1]);
    }

    job.sort();
    job.refresh();

    assert.strictEqual(await mineBlock(job), 'OK');

    let forked = false;
    chain.once('reorganize', () => {
      forked = true;
    });

    const block = await cpu.mineBlock(tip);
    assert(await chain.add(block));

    const entry = await chain.getEntry(block.hash());
    const block2 = await cpu.mineBlock(entry);

    assert(await chain.add(block2));

    assert(forked);
    assert.bufferEqual(block2.hash(), chain.tip.hash);
  });

  it('should inspect ChainEntry', async () => {
    const fmt = nodejsUtil.format(tip1);
    assert(typeof fmt === 'string');
    assert(fmt.includes('hash'));
    assert(fmt.includes('version'));
    assert(fmt.includes('chainwork'));
  });

  describe('Checkpoints', function() {
    before(async() => {
      const entry = await chain.getEntry(chain.tip.height - 5);
      assert(Buffer.isBuffer(entry.hash));
      assert(Number.isInteger(entry.height));

      network.checkpointMap[entry.height] = entry.hash;
      network.lastCheckpoint = entry.height;
    });

    after(async () => {
      network.checkpointMap = {};
      network.lastCheckpoint = 0;
    });

    it('will reject blocks before last checkpoint', async () => {
      const entry = await chain.getEntry(chain.tip.height - 10);
      const block = await cpu.mineBlock(entry);

      let err = null;

      try {
        await chain.add(block);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.equal(err.type, 'VerifyError');
      assert.equal(err.reason, 'bad-fork-prior-to-checkpoint');
      assert.equal(err.score, 100);
    });

    it('will accept blocks after last checkpoint', async () => {
      const entry = await chain.getEntry(chain.tip.height - 4);
      const block = await cpu.mineBlock(entry);

      assert(await chain.add(block));
    });
  });
});
