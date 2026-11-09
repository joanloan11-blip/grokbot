#!/usr/bin/env python3
"""Собирает config.json для xray-клиента из ссылки vless:// (файл ~/xray/vless.txt).
Ссылку не печатает. Клиент поднимает SOCKS5 на 0.0.0.0:1080 внутри сети mayak — через него
QASTOM AGENT ходит к OpenAI/Anthropic/Google в обход DPI."""
import json, sys, urllib.parse
from pathlib import Path

src = Path(sys.argv[1]).read_text().strip().splitlines()[0].strip()
if not src.startswith('vless://'):
    sys.exit('В файле нет ссылки vless://')
u = urllib.parse.urlsplit(src)
q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
uuid = urllib.parse.unquote(u.username or '')
host, port = u.hostname, u.port or 443
security = q.get('security', 'none')
network = q.get('type', 'tcp')

stream = {'network': network, 'security': security}
if security == 'reality':
    stream['realitySettings'] = {
        'serverName': q.get('sni', ''),
        'fingerprint': q.get('fp', 'chrome'),
        'publicKey': q.get('pbk', ''),
        'shortId': q.get('sid', ''),
        'spiderX': urllib.parse.unquote(q.get('spx', '')),
    }
elif security == 'tls':
    stream['tlsSettings'] = {
        'serverName': q.get('sni', host),
        'fingerprint': q.get('fp', 'chrome'),
        'alpn': [a for a in q.get('alpn', '').split(',') if a],
    }
if network == 'ws':
    stream['wsSettings'] = {'path': urllib.parse.unquote(q.get('path', '/')), 'headers': {'Host': q.get('host', '')}}
elif network == 'grpc':
    stream['grpcSettings'] = {'serviceName': q.get('serviceName', '')}
elif network in ('xhttp', 'splithttp'):
    stream['xhttpSettings'] = {'path': urllib.parse.unquote(q.get('path', '/')), 'host': q.get('host', ''), 'mode': q.get('mode', 'auto')}

user = {'id': uuid, 'encryption': q.get('encryption', 'none')}
if q.get('flow'):
    user['flow'] = q['flow']

config = {
    'log': {'loglevel': 'warning'},
    'inbounds': [{
        'tag': 'socks', 'listen': '0.0.0.0', 'port': 1080, 'protocol': 'socks',
        'settings': {'auth': 'noauth', 'udp': False},
    }],
    'outbounds': [{
        'tag': 'vless', 'protocol': 'vless',
        'settings': {'vnext': [{'address': host, 'port': port, 'users': [user]}]},
        'streamSettings': stream,
    }],
}
Path(sys.argv[2]).write_text(json.dumps(config, indent=2))
print(f'ok: {host}:{port} {network}/{security}' + (' flow' if q.get('flow') else ''))
