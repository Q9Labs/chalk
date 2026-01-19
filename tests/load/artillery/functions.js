module.exports = {
  generateToken: function(context, events, done) {
    // In real tests, fetch from API
    context.vars.token = process.env.WS_TOKEN;
    return done();
  },

  logResponse: function(context, events, done) {
    console.log('Response:', context.vars.response);
    return done();
  },
};
