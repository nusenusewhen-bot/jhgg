const MasterBot = require('./bot');

(async () => {
  const bot = new MasterBot();
  await bot.init();
  
  // Snapchat
  await bot.snapchatLogin('ghaith012x', 'Warrior2012@');
  
  // Discord
  // await bot.discordRaid('server-id', '@everyone', 50);
})();
