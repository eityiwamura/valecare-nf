require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const pool = require('./db/pool');

const authRoutes = require('./routes/auth');
const uploadRoutes = require('./routes/upload');
const notasRoutes = require('./routes/notas');
const dashboardRoutes = require('./routes/dashboard');
const codigosServicoRoutes = require('./routes/codigosServico');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'valecare-dev-secret-troque-em-producao',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12,
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === 'true'
  }
}));

app.use((req, res, next) => {
  res.locals.username = req.session.username || null;
  res.locals.currentPath = req.path;
  next();
});

app.get('/health', (req, res) => res.status(200).send('ok'));

app.use(authRoutes);
app.use(requireAuth, uploadRoutes);
app.use(requireAuth, notasRoutes);
app.use(requireAuth, dashboardRoutes);
app.use(requireAuth, codigosServicoRoutes);

app.get('/', requireAuth, (req, res) => res.redirect('/dashboard'));

app.use((req, res) => {
  res.status(404).render('404');
});

app.listen(PORT, () => {
  console.log(`Valecare NF rodando na porta ${PORT}`);
});
