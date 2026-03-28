require('dotenv').config();
const app = require('./server');

const PORT = process.env.PORT || 3000;

// MUST bind to 0.0.0.0 for Railway
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Running on port ${PORT}`);
});
