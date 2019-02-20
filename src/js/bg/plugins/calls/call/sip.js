/**
* @module ModuleCalls
*/
const Call = require('./index')

/**
* Call implementation for incoming and outgoing calls
* using WebRTC and SIP.js.
*/
class CallSIP extends Call {
    /**
    * @param {AppBackground} app - The background application.
    * @param {String|Number|Session} [target] - An endpoint identifier to call to.
    * @param {Object} [options] - An endpoint identifier to call to.
    * @param {Boolean} [options.active] - Activates this Call in the UI.
    * @param {Boolean} [options.silent] - Setup a Call without interfering with the UI.
    */
    constructor(app, target, {active, silent} = {}) {
        super(app, target, {active, silent})

        if (!target || ['string', 'number'].includes(typeof target)) {
            // Passing in no target or a number means an outgoing call.
            app.__mergeDeep(this.state, {keypad: {mode: 'call'}, number: target, status: 'new', type: 'outgoing'})
        } else {
            // Passing in a session as target means an incoming call.
            app.__mergeDeep(this.state, {keypad: {mode: 'dtmf'}, status: 'invite', type: 'incoming'})
            this.session = target
        }
    }


    /**
    * Handle an incoming `invite` call from.
    */
    _incoming() {
        // (!) Set the state before calling super.
        this.state.displayName = this.session.remoteIdentity.displayName

        // Try to get the caller info first from the RPID.
        let rpid = this.session.transaction.request.getHeader('Remote-Party-Id')
        if (rpid) {
            rpid = this._parseRpid(rpid)
            Object.assign(this.state, rpid)
        } else {
            this.state.number = this.session.remoteIdentity.uri.user
        }

        this.state.stats.callId = this.session.request.call_id
        this.app.logger.debug(`${this}incoming call ${this.state.stats.callId} started`)
        super._incoming()

        // Setup some event handlers for the different stages of a call.
        this.session.on('accepted', (request) => {
            this.app.telemetry.event('call[sip]', 'incoming', 'accepted')
            this._start({message: this.translations.accepted.incoming})
        })

        this.session.on('bye', (e) => {
            this.busyTone.play()
            if (e.getHeader('X-Asterisk-Hangupcausecode') === '58') {
                this.app.notify({
                    icon: 'warning',
                    message: this.app.$t('your VoIP account misses AVPF and encryption support.'),
                    type: 'warning',
                })
            }

            this.setState({status: 'bye'})
            this._stop({message: this.translations[this.state.status]})
        })

        /**
        * The `failed` event is triggered when a call is being rejected,
        * but also when an incoming calls keeps ringing for a certain amount
        * of time (60 seconds), and fails due to a timeout. In that case,
        * no `rejected` event is triggered and we need to kill the
        * call ASAP, so a new INVITE for the same call will be accepted by the
        * call module's invite handler.
        * See: https://sipjs.com/api/0.11.0/session/#failed
        * And: https://sipjs.com/api/0.11.0/causes/
        */
        this.session.on('failed', (response, cause) => {
            this.app.logger.info(`${this}incoming call failed caused by: ${cause}`)

            if (response) {
                if (typeof response === 'string') response = SIP.Parser.parseMessage(response, this.module.ua)

                let reason = response.getHeader('Reason')
                if (reason) reason = this._parseHeader(reason).get('text')

                if (reason === 'Call completed elsewhere') {
                    // `Call completed elsewhere` is not considered to be
                    // a missed call and will not end up in the activity log.
                    this.app.logger.info(`${this}call completed elsewhere: ${this.state.stats.callId}`)
                    this.app.telemetry.event('call[sip]', 'incoming', 'answered_elsewhere')
                    this.setState({status: 'answered_elsewhere'})
                } else {
                    this.setState({status: 'request_terminated'})
                    this.app.emit('bg:calls:call_rejected', {call: this.state}, true)
                    this.app.telemetry.event('call[sip]', 'incoming', 'rejected')
                }
            } else {
                this.setState({status: 'request_terminated'})
            }

            this._stop({message: this.translations[this.state.status]})
        })


        // Check for the RPID. Update the display name and number to the
        // transferred caller, if there is one.
        this.session.on('reinvite', (session, request) => {
            let _rpid = request.getHeader('Remote-Party-Id')
            if (_rpid) {
                _rpid = this._parseRpid(_rpid)
                this.setState(_rpid)
            }
        })
    }


    /**
    * Setup an outgoing call.
    * @param {(Number|String)} number - The number to call.
    */
    _outgoing() {
        super._outgoing()
        this.session = this.module.ua.invite(`sip:${this.state.number}@voipgrid.nl`, {
            sessionDescriptionHandlerOptions: {
                constraints: this.app.media._getUserMediaFlags(),
            },
        })

        this.setState({stats: {callId: this.session.request.call_id}})

        // Notify user about the new call being setup.
        this.session.on('accepted', (data) => {
            this.app.telemetry.event('call[sip]', 'outgoing', 'accepted')
            this._start({message: this.translations.accepted.outgoing})
        })

        // Reset call state when the other halve hangs up.
        this.session.on('bye', (e) => {
            this.busyTone.play()
            this.setState({status: 'bye'})
            this._stop({message: this.translations[this.state.status]})
        })

        // Handle connecting streams to the appropriate video element.
        this.session.on('trackAdded', async() => {
            this.localStream = new MediaStream()
            this.remoteStream = new MediaStream()

            this.pc = this.session.sessionDescriptionHandler.peerConnection
            this.pc.getReceivers().forEach((receiver) => this.remoteStream.addTrack(receiver.track))
            this.app.media.remoteVideo.srcObject = this.remoteStream

            this.pc.getSenders().forEach((sender) => this.localStream.addTrack(sender.track))
            this.app.media.localVideo.srcObject = this.localStream
        })

        /**
        * Play a ringback tone on the following status codes:
        * 180: Ringing
        * 181: Call is Being Forwarded
        * 182: Queued
        * 183: Session in Progress
        */
        this.session.on('progress', (e) => {
            if ([180, 181, 182, 183].includes(e.status_code)) {
                this.ringbackTone.play()
            }
        })


        // Blind transfer.
        this.session.on('refer', (target) => {
            this.session.bye()
        })

        /**
         * See: https://sipjs.com/api/0.11.0/session/#failed
         * And: https://sipjs.com/api/0.11.0/causes/
         */
        this.session.on('failed', (response, cause) => {
            this.app.logger.info(`${this}outgoing call fail caused by: ${cause}`)
            // The busy tone is only audible for the calling party.
            this.busyTone.play()

            if (cause === SIP.C.causes.BUSY) {
                this.setState({status: 'callee_busy'})
            } else {
                this.setState({status: 'request_terminated'})
            }

            this.app.emit('bg:calls:call_rejected', {call: this.state}, true)
            this.app.telemetry.event('call[sip]', 'outgoing', 'rejected')
            this._stop({message: this.translations[this.state.status]})
        })
    }


    /**
    * Convert a comma-separated string like:
    * `SIP;cause=200;text="Call completed elsewhere` to a Map.
    * @param {String} header - The header to parse.
    * @returns {Map} - A map of key/values of the header.
    */
    _parseHeader(header) {
        return new Map(header.replace(/\"/g, '').split(';').map((i) => i.split('=')))
    }


    /**
    * Pass the name and number of the caller from the Remote-Party-ID header.
    * @param {String} header - The raw RPID header string.
    * @returns {Object} - displayName and number properties that map to state.
    */
    _parseRpid(header) {
        let rpid = {displayName: '', number: 'unknown'}

        const numberMatch = (/<(.*)>/g).exec(header)
        const nameMatch = (/"(.*?)"/g).exec(header)

        if (numberMatch) {
            try {
                rpid.number = numberMatch[1].split('@')[0].replace('sip:', '')
            } catch (err) {
                this.app.logger.warn(`${this}failed to parse rpid header ${header}`)
                rpid.number = numberMatch[0]
            }
        }

        if (nameMatch) {
            rpid.displayName = nameMatch[1]
        }

        return rpid
    }


    /**
    * Accept an incoming session.
    */
    accept() {
        super.accept()

        // Handle connecting streams to the appropriate video element.
        this.session.on('trackAdded', () => {
            this.localStream = new MediaStream()
            this.remoteStream = new MediaStream()

            this.pc = this.session.sessionDescriptionHandler.peerConnection
            this.pc.getReceivers().forEach((receiver) => this.remoteStream.addTrack(receiver.track))
            this.app.media.remoteVideo.srcObject = this.remoteStream

            // @NOTE Disabled the following, this caused major issues when accepting a call.
            // `sender.track` was always null, causing fatal errors.
            // this.pc.getSenders().forEach((sender) => this.localStream.addTrack(sender.track))
            // this.app.media.localVideo.srcObject = this.localStream
        })
        this.session.accept({
            sessionDescriptionHandlerOptions: {
                constraints: this.app.media._getUserMediaFlags(),
            },
        })
    }


    hold() {
        if (this.session) {
            this.session.hold({
                sessionDescriptionHandlerOptions: {
                    constraints: this.app.media._getUserMediaFlags(),
                },
            })
            this.setState({hold: {active: true}})
        }
    }


    async start() {
        if (this.silent) {
            if (this.state.status === 'invite') this._incoming()
            else this._outgoing()
        } else {
            // Query media and assign the stream. The actual permission must be
            // already granted from a foreground script running in a tab.
            try {
                await this._initSinks()
                if (this.state.status === 'invite') this._incoming()
                else this._outgoing()
            } catch (err) {
                console.error(err)
            }
        }
    }


    /**
    * Terminate a Call depending on it's current status.
    */
    terminate() {
        if (this.state.status === 'new') {
            // An empty/new call; just delete the Call object without noise.
            this.module.deleteCall(this)
            return
        } else if (this.state.status === 'create') {
            // A fresh outgoing Call; not yet started. There may or may not
            // be a session object. End the session if there is one.
            if (this.session) this.session.terminate()
            this.setState({status: 'request_terminated'})
            // The session's closing events will not be called, so manually
            // trigger the Call to stop here.
            this._stop()
        } else {

            // Calls with other statuses need some more work to end.
            try {
                if (this.state.status === 'invite') {
                    this.setState({status: 'request_terminated'})
                    // Decline an incoming call with 'Busy Here'.
                    this.session.reject({statusCode: 486})
                } else if (['accepted'].includes(this.state.status)) {
                    // Hangup a running call.
                    this.session.bye()
                    // Set the status here manually, because the bye event on the
                    // session is not triggered.
                    this.setState({status: 'bye'})
                }
            } catch (err) {
                this.app.logger.warn(`${this}unable to close the session properly. (${err})`)
                // Get rid of the Call anyway.
                this._stop()
            }
        }
    }


    /**
    * Generate a representational name for this module. Used for logging.
    * @returns {String} - An identifier for this module.
    */
    toString() {
        return `${this.app}[CallSIP][${this.id}] `
    }


    transfer(targetCall) {
        if (typeof targetCall === 'string') {
            this.session.refer(`sip:${targetCall}@voipgrid.nl`)
        } else {
            this.session.refer(targetCall.session)
        }
    }


    unhold() {
        if (this.session) {
            this.session.unhold({
                sessionDescriptionHandlerOptions: {
                    constraints: this.app.media._getUserMediaFlags(),
                },
            })
            this.setState({hold: {active: false}})
        }
    }
}

module.exports = CallSIP
