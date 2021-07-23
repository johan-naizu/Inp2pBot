const { Telegraf } = require('telegraf');
const { parsePaymentRequest } = require('invoices');
const { Order, User } = require('../models');
const { createOrder } = require('./createOrders');
const { settleHoldInvoice, createHoldInvoice, subscribeInvoice } = require('../ln');
const { validateSellOrder, validateUser, validateBuyOrder, validateTakeSell, validateBuyInvoice, validateTakeBuyOrder, validateReleaseOrder, validateTakeBuy, validateTakeSellOrder, validateRelease } = require('./validations');
const messages = require('./messages');

const start = () => {
  console.log(process.env.BOT_TOKEN);
  const bot = new Telegraf(process.env.BOT_TOKEN);

  bot.start(async (ctx) => {
    messages.startMessage(ctx);
    await validateUser(ctx, true);
  });

  bot.command('sell', async (ctx) => {
    const user = await validateUser(ctx, false);
    if (!user) return;

    const sellOrderParams = await validateSellOrder(ctx, bot, user);

    if (!sellOrderParams) return;

    const [_, amount, fiatAmount, fiatCode, paymentMethod] = sellOrderParams;

    const { request, order } = await createOrder(ctx, bot, {
      type: 'sell',
      amount,
      seller: user,
      fiatAmount,
      fiatCode,
      paymentMethod,
    });

    if (!!order) await messages.invoicePaymentRequestMessage(bot, user, request);
  });

  bot.command('buy', async (ctx) => {
    const user = await validateUser(ctx, false);
    if (!user) return;

    const buyOrderParams = await validateBuyOrder(ctx, bot, user);
    if (!buyOrderParams) return;

    const [_, amount, fiatAmount, fiatCode, paymentMethod, lnInvoice] = buyOrderParams;

    // validamos la invoice
    const invoice = parsePaymentRequest({ request: lnInvoice });
    if (!(await validateBuyInvoice(bot, user, invoice, amount))) return;

    const { order } = await createOrder(ctx, bot, {
      type: 'buy',
      amount,
      buyer: user,
      fiatAmount,
      fiatCode,
      paymentMethod,
      buyerInvoice: lnInvoice || '',
      status: 'PENDING',
    });

    if (!!order) {
      await messages.publishBuyOrderMessage(ctx, bot, order);
      await messages.pendingBuyMessage(bot, user);
    }
  });

  bot.command('takesell', async (ctx) => {
    const user = await validateUser(ctx, false);
    if (!user) return;

    const takeSellParams = await validateTakeSell(ctx, bot, user);
    if (!takeSellParams) return;

    const [_, orderId, lnInvoice] = takeSellParams;

    try {
      // validamos la invoice
      const invoice = parsePaymentRequest({ request: lnInvoice });
      const order = await Order.findOne({ _id: orderId });
      if (!(await validateTakeSellOrder(bot, user, invoice, order))) return;

      order.status = 'ACTIVE';
      order.buyerId = user._id;
      order.buyerInvoice = lnInvoice;
      await order.save();

      const orderUser = await User.findOne({ _id: order.creatorId });
      await messages.beginTakeSellMessage(bot, orderUser, user, order);
    } catch (e) {
      console.log(e);
      await messages.invalidDataMessage(bot, user);
    }
  });

  bot.command('takebuy', async (ctx) => {
    const user = await validateUser(ctx, false);
    if (!user) return;

    const takeBuyParams = await validateTakeBuy(ctx, bot, user);
    if (!takeBuyParams) return;

    const [_, orderId] = takeBuyParams;
    try {
      const order = await Order.findOne({ _id: orderId });
      if (!(await validateTakeBuyOrder(bot, user, order))) return;

      const invoiceDescription = `Venta por @P2PLNBot`;
      const { request, hash, secret } = await createHoldInvoice({
        description: invoiceDescription,
        amount: order.amount + order.amount * process.env.FEE,
      });
      order.hash = hash;
      order.secret = secret;
      order.status = 'ACTIVE';
      order.sellerId = user._id;
      await order.save();

      // monitoreamos esa invoice para saber cuando el usuario realice el pago
      await subscribeInvoice(ctx, bot, request);

      const orderUser = await User.findOne({ _id: order.creatorId });
      await messages.beginTakeBuyMessage(bot, user, orderUser, request, order);
    } catch (e) {
      console.log(e);
      await messages.invalidDataMessage(bot, user);
    }
  });

  bot.command('release', async (ctx) => {
    const user = await validateUser(ctx, false);
    if (!user) return;

    const releaseParams = await validateRelease(ctx, bot, user);
    if (!releaseParams) return;

    const [_, orderId] = releaseParams;

    const order = await validateReleaseOrder(bot, user, orderId);
    if (!order) return;

    await settleHoldInvoice({ secret: order.secret });
  });

  bot.launch();

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
};

module.exports = start;