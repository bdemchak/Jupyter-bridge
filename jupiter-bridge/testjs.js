alert("hi from github start")

    /*
    These functions serve as a bridge between a remote Jupyter server and Cytoscape. They proxy
    the Jupyter server's HTTP calls (coming from a Jupyter Notebook with py4cytoscape) to
    Cytoscape's CyREST layer. Note that for the case of a Jupyter server running on the same
    machine as Cytoscape, this bridge isn't necessary because the Jupyter server's HTTP calls
    can easily connect to Cytoscape over localhost. So, this bridge solves the problem of
    a Jupyter server (e.g., Google's Colab) that can't connect to Cytoscape that sits behind
    a firewall.

    At a high level, py4cytoscape running in a remote Jupyter server sends its request to
    the Jupyter Bridge, which holds the request until this Javascript Bridge picks it up. The
    Javascript Bridge fulfills the request by making an HTTP request to Cytoscape's CyREST. When
    it gets a result, it passes it back to Jupyter Bridge, and py4cytoscape picks it up and
    and continues execution of the Notebook.

    The request represents an HTTP call that py4cytoscape would normally make via HTTP directly
    to Cytoscape via localhost when both py4cytoscape and Cytoscape are running on the same machine.
    The possible requests are:

    GET(url, params) - may return plain text or JSON
    POST(url, params, body as JSON) - may return plain text or JSON
    POST(url, data as JSON, headers as {'Content-Type': 'application/json', 'Accept': 'application/json'} - returns JSON
    PUT(url, params, body as JSON) - may return plain text or JSON
    DELETE(url, params)

    To handle this:
    * The URL is rewritten to be http://localhost:1234
    * The params is passed in as stringified JSON
    * The body is passed in as stringified JSON
    * The data is passed in as stringified JSON
    * Headers are passed in as stringified JSON
    * Data and status are passed back as text and interpreted by the caller

    Unhandled requests (so far):
    webbrowser.open()

     */

//const JupyterBridge = 'http://192.168.2.194:9529' // for production
const JupyterBridge = 'http://127.0.0.1:9529' // for testing against local Jupyter-bridge

const LocalCytoscape = 'http://127.0.0.1:1234'
const Channel = '1'

function parseURL(url) {
    var reURLInformation = new RegExp([
        '^(https?:)//', // protocol
        '(([^:/?#]*)(?::([0-9]+))?)', // host (hostname and port)
        '(/{0,1}[^?#]*)', // pathname
        '(\\?[^#]*|)', // search
        '(#.*|)$' // hash
    ].join(''));
    var match = url.match(reURLInformation);
    return match && {
        url: url,
        protocol: match[1],
        host: match[2],
        hostname: match[3],
        port: match[4],
        pathname: match[5],
        search: match[6],
        hash: match[7]
    }
}

var showDebug = false

const httpR = new XMLHttpRequest();
function replyCytoscape(replyStatus, replyStatusText, replyText) {

    // Clean up after Jupyter bridge accepts reply
    httpR.onreadystatechange = function() {
        if (httpR.readyState === 4) {
            if (showDebug) {
                console.log(' status: ' + httpR.status + ', reply: ' + httpR.responseText)
            }
        }
    }

    var reply = {'status': replyStatus, 'reason': replyStatusText, 'text': replyText}

    // Send reply to Jupyter bridge
    var jupyterBridgeURL = JupyterBridge + '/queue_reply?channel=' + Channel
    if (showDebug) {
        console.log('Starting queue to Jupyter bridge: ' + jupyterBridgeURL)
    }
    httpR.open('POST', jupyterBridgeURL, true)
    httpR.setRequestHeader('Content-Type', 'text/plain')
    httpR.send(JSON.stringify(reply))
}

const httpC = new XMLHttpRequest();
function callCytoscape(callSpec) {

    // Captures Cytoscape reply and sends it on
    httpC.onreadystatechange = function() {
        if (httpC.readyState === 4) {
            if (showDebug) {
                console.log(' status: ' + httpC.status + ', statusText: ' + httpC.statusText + ', reply: ' + httpC.responseText)
            }
            // Note that httpC.status is 0 if the URL can't be reached *OR* there is a CORS violation.
            // I wish I could tell the difference because for a CORS violation, I'd return a 404,
            // which would roughly match what Python's native request package would return.
            // The practical consequence is that the ultimate caller (e.g., py4cytoscape)
            // returns different exceptions, depending on wither this module is doing the
            // HTTP operation or the native Python requests package is. This is minor, but
            // messes up tests that verify the exception type.
            replyCytoscape(httpC.status, httpC.statusText, httpC.responseText)
            waitOnJupyterBridge(false)
        }
    }

    // Build up request to Cytoscape, making sure host is local
//    too heavy handed: localURL = LocalCytoscape + parseURL(callSpec.url).pathname
    var localURL = callSpec.url // Try using what was passed in ... is there a security risk??

    if (showDebug) {
        console.log('Command: ' + callSpec.command + ' (' + localURL + ')')
        if (callSpec.params) {
            console.log(' params: ' + JSON.stringify(callSpec.params))
        }
        if (callSpec.headers) {
            console.log(' header: ' + JSON.stringify(callSpec.headers))
        }
        if (callSpec.data) {
            console.log('   data: ' + JSON.stringify(callSpec.data))
        }
    }

    var joiner = '?'
    for (param in callSpec.params) {
        localURL = localURL + joiner + param + '=' + encodeURIComponent(callSpec.params[param])
        joiner = '&'
    }

    httpC.open(callSpec.command, localURL, true)
    for (header in callSpec.headers) {
        httpC.setRequestHeader(header, callSpec.headers[header])
    }

    // Send request to Cytoscape ... reply goes to onreadystatechange handler
    httpC.send(JSON.stringify(callSpec.data))
}

const httpJ = new XMLHttpRequest()
function waitOnJupyterBridge(resetFirst) {

    // Captures request from Jupyter bridge
    httpJ.onreadystatechange = function() {
        if (httpJ.readyState === 4) {
            if (showDebug) {
                console.log(' status: ' + httpJ.status + ', reply: ' + httpJ.responseText)
            }
            try {
                callCytoscape(JSON.parse(httpJ.responseText))
            } catch(err) {
                // Bad responseText means client disconnected, so there's no payload.
                // Go wait on another request, as there's nothing to call Cytoscape with.
                waitOnJupyterBridge(false)
            }
        }
    }

    // Wait for request from Jupyter bridge
    var jupyterBridgeURL = JupyterBridge + '/dequeue_request?channel=' + Channel
    if (resetFirst) {
        jupyterBridgeURL = jupyterBridgeURL + '&reset'
    }
    if (showDebug) {
        console.log('Starting dequeue on Jupyter bridge: ' + jupyterBridgeURL)
    }
    httpJ.open('GET', jupyterBridgeURL, true)
    httpJ.send()
}

// This kicks off a loop that ends by calling waitOnJupyterBridge again. This first call
// ejects any dead readers before we start a read
waitOnJupyterBridge(true) // Wait for message from Jupyter bridge, execute it, and return reply

/*
    Test cases for local debugging between this module and Cytoscape,
    not involving Jupyter-bridge.

    Disable waitOnJupyterBridge call before trying one of these
 */

// const testGET1 = { // expect 200 {"apiVersion": "v1", "cytoscapeVersion": "3.9.0-SNAPSHOT"}
//     "command": "GET",
//     "url": "http://somehost:9999/v1/version",
//     "params": null,
//     "data": null,
//     "headers": null,
// }
//callCytoscape(testGET1)

// const testPOST1 = { // expect 200 {"data": ["string"], "errors": []}
//     "command": "POST",
//     "url": "http://somehost:9999/v1/commands/command/echo",
//     "params": null,
//     "data": {"message": "this is a message"},
//     "headers": {"Content-Type": "application/json", "Accept": "application/json"},
// }
//callCytoscape(testPOST1)

// const testPUT1 = { // expect 200 {"data": {}, "errors": []}
//     "command": "PUT",
//     "url": "http://somehost:9999/v1/networks/currentNetwork",
//     "params": null,
//     "data": {"networkSUID": "1056223"},
//     "headers": {"Content-Type": "application/json", "Accept": "application/json"},
// }
//callCytoscape(testPUT1)

// const testDELETE1 = { // expect 200 no-content}
//     "command": "DELETE",
//     "url": "http://somehost:9999/v1/networks/1056223",
//     "params": null,
//     "data": null,
//     "headers": {"Accept": "application/json"},
// }
//callCytoscape(testDELETE1)

// const testCOMMAND1 = { // expect 200 {"data": {}, "errors": []}
//     "command": "POST",
//     "url": "http://somehost:9999/v1/commands/session/open",
//     "params": null,
//     "data": {"file": "C:\\Program Files\\Cytoscape_v3.9.0-SNAPSHOT-May 29\\sampleData\\galFiltered.cys"},
//     "headers": {"Content-Type": "application/json", "Accept": "application/json"},
// }
//callCytoscape(testCOMMAND1)

alert("hi from github end")