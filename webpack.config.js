const path = require('path');

module.exports = {
  mode: 'none',
  entry: './src/client.js',
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'lib'),
    filename: 'dist.js',
    library: {
      type: 'commonjs2'
    }
  },
  externals: [
    /^[^\\.]/,
    {
      '../messages/clientMessage': '../src/messages/clientMessage'
    }
  ],
  experiments: {
    topLevelAwait: true
  }
}
