# Speaker-Worker

The `speaker-worker` allows for receiving text, and then uses cloud services to synthesize
that to speech, and outputs it to speakers of the system. Works on Windows, macOS, and Linux.

Under the hood, the system utilizes a cache where any synthesized speech is saved to a file, and
that file used on subsequent calls for that combination of text, language, and voice. The cache,
and the generated files, are stored in the `cache/` directory that is created the first time you
run the application.

## Installation

After cloning the repository, you need to run the following to set-up the module:

```bash
npm install
cp cog-sample.json cog.json
```

After that, edit `cog.json` to have the credentials you need for RabbitMQ, etc.

Note, there is an [open bug](https://github.com/TooTallNate/node-speaker/issues/95) with the speaker module
used by the speaker-worker on macOS that causes an "Illegal Hardware Instruction" error. While this does not
seem to cause any issue in actually playing the synthesized output, and this module attempts to properly handle
this issue internally, the error can be avoided by doing:

```bash
npm install --mpg123-backend=openal
```

## Usage

```bash
npm start
```

Access the web UI by going to `http://localhost:8989` or whatever port you have set-up in the `cog.json` file.

Note: If you would like to run the project directly, you will have to first compile it by
using `npm run build` and then you can directly run `node dist/speaker.js`.

## Credentials

The speaker-worker relies on the [Watson Text-to-Speech service](https://cloud.ibm.com/apidocs/text-to-speech) to
handle the synthesis of text to speech. Under the hood, we use the [ibm-watson](https://www.npmjs.com/package/ibm-watson)
library to handle connecting to it. Currently, this module only supports using the `ibm-credentials.env` file for
authentication. See the [ibm-watson#credentials-file](https://www.npmjs.com/package/ibm-watson#credentials-file-easier)
section on how to get this file for the Text-to-Speech service.

## Cog Configuration

To run this, you need to have a `cog.json` file in your application's directory (see `cog-sample.json` for
a starting point). You will minimally want to define a `port`, but can also specify a number of application
specific settings shown below:

```json
{
  "speaker": {
    "language": "en-US",
    "voices": {
      "en-US": "LisaVoice"
    },
    "volume": 1
  }

}
```

If any of these values are omitted from the `cog.json` file, then the default shown above will be
used instead. Each of these can be changed during operation through the RabbitMQ interface. Please see the
web UI for the list of available languages and voices for each language. Volume should be a decimal number
between 0 and 1.

## RabbitMQ

In addition to the Web UI, the service is functional over RabbitMQ. To use RabbitMQ, make sure in the `cog.json`
file you minimally have `rabbit: true` or configure it as necessary. See
[@cisl/io#RabbitMQ](https://github.com/cislrpi/io#rabbitmq) for more details. Note, all messages should be sent
with the `content-type: application/json` header, or else this library will fail to understand the message.
Please consult your RabbitMQ library for details on how to set that.

The service listens on the following topics on the exchange:

* speaker.command.cache.clear
* speaker.command.speaker.change
* speaker.command.volume.change

And the following RPC queue:

* rpc-speaker-speakText
* (TODO) rpc-speaker-getSynthesizedSpeech
* (TODO) rpc-speaker-playBuffer
* rpc-speaker-stop

The service outputs on the following topics on configured exchange:

* speaker.speak.content
* speaker.speak.begin
* speaker.speak.end

### rpc-speaker-speakText

Use this to send a message to the `speaker-worker` to play it using the specified language and voice.
Accepts the following payload:

```javascript
{
  "text": "text to speak",        // REQUIRED
  "language": "language to use",  // OPTIONAL
  "voice": "voice to use"         // OPTIONAL
}
```

A reply will be returned on the RPC queue after the audio has finished playing, which will be a JSON object with
the following structure if it succeeded:

```javascript
{
  "status": "success",
  "data": {
    "language": "en-US",
    "volume": 1,
    "timestamp": "2019-10-24T16:29:08.328Z",
    "text": "Hello World",
    "voice": "AllisonV3Voice",
    "timings": [["Hello", 0, 0.338], ["World", 0.338, 0.77]]
  }
}
```

Or if there's an error:

```javascript
{
  "status": "error",
  "message": "string describing what the error is"
}
```

### rpc-speaker-getSynthesizedSpeech

Use this to send a message to the `speaker-worker` to get back a Buffer of the synthesized language and voice.
Accepts the following payload:

```javascript
{
  "text": "text to speak",        // REQUIRED
  "language": "language to use",  // OPTIONAL
  "voice": "voice to use"         // OPTIONAL
}
```

### rpc-speaker-stop

Use this to have the `speaker-worker` stop talking, killing any existing `ffmpeg` process.

Does not accept a payload. Replies after killing `ffmpeg`.

### speaker.command.cache.clear

Does not require anything for the payload, will clear the cache.

### speaker.command.default.language

Accepts the following payload:

```javascript
{
  "language": "language to set default to"
}
```

### speaker.command.default.voice

Accepts the following payload:

```javascript
{
  "language": "language of voice",
  "voice": "voice to set default to for language"
}
```

### speaker.command.volume.change

Accepts the following payload:

```javascript
{
  "change": .35, // Number to change volume by
  "volume": 1    // Number to set volume to
}
```

### speaker.speak.content

This is sent after the synthesizing has finished, and immediately before attempting to play the file

Will output the following payload:

```javascript
{
  "text": "Hello world",
  "voice": "en-US",
  "language": "LisaVoice",
  "time_captured": 1570217252405,
  "timestamp": "019-10-04T19:25:10.102Z",
  "speaker": "speaker-worker"
}
```

### speaker.speak.begin

This is sent after the stream instance has been created, and right before it plays the voice, similar to `speaker.speak.content`.

Will output the following payload:

```javascript
{
  "text": "Hello world",
  "language": "en-US",
  "voice": "LisaVoice",
  "timestamp": "2019-10-04T19:25:10.102Z"
  "timings": [["Hello", 0, 0.338], ["World", 0.338, 0.77]],
  "volume": 1,
}
```

(Note, timings is only available for synthesized speech going through Watson TTS)

### speaker.speak.end

This is sent after stream has finished outputting the audio file.

Will output the following payload:

```javascript
{
  "text": "Hello world",
  "language": "en-US",
  "voice": "LisaVoice",
  "timestamp": "2019-10-04T19:25:10.102Z",
  "timings": [["Hello", 0, 0.338], ["World", 0.338, 0.77]],
  "volume": 1,
}
```

(Note, timings is only available for synthesized speech going through Watson TTS)
