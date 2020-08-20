class WebSocketClient {
  constructor() {
    this.number = 0;
    this.autoReconnectInterval = 5 * 1000;
  }

  open(url) {
    this.url = url;
    console.log(`WebSocket: connecting to ${this.url}`);
    this.client = new WebSocket(this.url);
    this.client.onopen = () => {
      console.log(`WebSocket: connected;`)
    };

    this.client.onmessage = (event) => {
      this.number++;
      this.onmessage(event);
    };

    this.client.onclose = (event) => {
      switch (event.code) {
        case 1000:
          console.log('WebSocket: Closed');
          break;
        default:
          this.reconnect();
          break;
      }
      //this.onclose(event);
    };

    this.client.onerror = (error) => {
      switch(error.code) {
        case 'ECONNREFUSED':
          this.reconnect();
          break;
        default:
          //console.log(`WebSocket: Error - ${error.code}`);
          //this.onerror(error);
          break;
      }
    };
  }

  send(data) {
    this.client.send(data);
  }

  removeClientListeners() {
    this.client.onopen = null;
    this.client.onmessage = null;
    this.client.onclose = null;
    this.client.onerror = null;
  }

  reconnect() {
    console.log(`WebSocketClient: Retry in ${this.autoReconnectInterval}ms`);
    this.removeClientListeners();
    setTimeout(() => {
      console.log("WebSocketClient: Reconnecting...");
      this.open(this.url);
    }, this.autoReconnectInterval);
  }

  onmessage(event) {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'history') {
        let elem = document.createElement('div');
        elem.textContent = `[${data.timestamp}] ${data.language}_${data.voice}: ${data.text}`;
        document.getElementById('history').prepend(elem);
      }
    }
    catch (ex) {
      console.error('invalid message');
    }
  }
}

let language_chooser = document.getElementById('lang-choose');
let current_language = language_chooser.value
document.getElementById(`${current_language}-voices`).style.display = 'block';
language_chooser.addEventListener('change', (event) => {
    document.getElementById(`${current_language}-voices`).style.display = 'none';
    current_language = event.target.value;
    document.getElementById(`${current_language}-voices`).style.display = 'block';
});

const ws = new WebSocketClient();
ws.open(location.href.replace('http', 'ws'));

document.getElementById('speaker-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    text: document.getElementById('text').value,
    language: current_language,
    voice: document.getElementById(`${current_language}-voices-select`).value
  };
  const resp = await fetch(location.href, {
    method: 'post',
    body: JSON.stringify(body),
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  });
  const json = await resp.json();
  console.log(json);
});
