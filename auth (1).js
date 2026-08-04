const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { redirectIfAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/login', redirectIfAuth, (req, res) => {
  res.render('login', { erro: null });
});

router.post('/login', redirectIfAuth, async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user) {
      return res.render('login', { erro: 'Usuário ou senha inválidos.' });
    }
    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) {
      return res.render('login', { erro: 'Usuário ou senha inválidos.' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('login', { erro: 'Erro ao autenticar. Tente novamente.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
