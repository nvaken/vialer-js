/**
* This module is responsible for handling all UI-related state and
* respond with UI-specific calls to watchers. UI changes may
* be related to WebExtension-, Electron- or WebView-specific actions
* @module ModuleUI
*/
const Plugin = require('vialer-js/lib/plugin')


/**
* Main entrypoint for UI.
* @memberof AppBackground.plugins
*/
class PluginUI extends Plugin {
    /**
    * Setup some menubar and click-to-dial icon related properties.
    * @param {AppBackground} app - The background application.
    */
    constructor(app) {
        super(app)
        this.animationStep = 0
        this.animations = {
            ringing: {
                direction: 1,
                frame: 0,
                frames: 5,
                intervalId: null,
            },
        }
        // Used to restore the Click-to-dial icon label message when
        // a tab refreshes and a call is still ongoing.
        this.lastLabelMessage = null
    }


    /**
    * Add an animating dot to the menubar by using the setIcon
    * method for the menubar as a way to set animation frames.
    * @param {String} name - One of the animation presets defined in `this.animations`.
    */
    __menubarAnimation(name) {
        // Clear all previously set animations.
        if (!name) {
            for (let _name of Object.keys(this.animations)) {
                if (this.animations[_name].intervalId) {
                    clearInterval(this.animations[_name].intervalId)
                }
            }
            return
        }
        let animation = this.animations[name]
        animation.intervalId = window.setInterval(() => {
            browser.browserAction.setIcon({path: `img/menubar-ringing-${this.animations[name].frame}.png`})
            if (animation.direction === 1) {
                animation.frame += 1
                // Reverse the direction on the last frame.
                if (animation.frame === (animation.frames - 1)) animation.direction = -animation.direction
            } else {
                animation.frame -= 1
                // Reverse the direction on the first frame.
                if (animation.frame === 0) animation.direction = -animation.direction
            }
        }, 100)
    }


    /**
    * Set the menubar icon in WebExtensions.
    * @param {String} name - The name of the menubar png to set.
    */
    __menubarIcon(name) {
        if (this.app.env.isExtension && name) {
            browser.browserAction.setIcon({path: `img/menubar-${name}.png`})
        }
    }


    /**
    * Initializes the module's store.
    * @returns {Object} The module's store properties.
    */
    _initialState() {
        return {
            layer: 'login',
            menubar: {
                base: 'inactive',
                event: null,
            },
            overlay: null,
            tabs: {
                activity: {
                    active: 'recent',
                },
                settings: {
                    active: 'general',
                },
            },
            visible: false,
        }
    }


    /**
    * Keep track of the popup state in a WebExtension by
    * establishing a connection between the popup script
    * and the background script.
    */
    _ready() {
        this.__menubarIcon(this.app.state.ui.menubar.base)
        if (this.app.env.isExtension) {
            this.app.setState({ui: {visible: false}})
            // A connection between the popup script and the background
            // is made. A new connection means the popup just opened, while
            // a closing connecting means that the popup closed.
            browser.runtime.onConnect.addListener((port) => {
                this.app.setState({ui: {visible: true}})
                for (let moduleName of Object.keys(this.app.plugins)) {
                    if (this.app.plugins[moduleName]._onPopupAction) {
                        this.app.plugins[moduleName]._onPopupAction('open')
                    }
                }

                // Triggered when the popup closes.
                port.onDisconnect.addListener((msg) => {
                    // Remove any overlay when the popup closes.
                    this.app.setState({ui: {overlay: null, visible: false}})
                    for (let moduleName of Object.keys(this.app.plugins)) {
                        if (this.app.plugins[moduleName]._onPopupAction) {
                            this.app.plugins[moduleName]._onPopupAction('close')
                        }
                    }
                })
            })
        } else {
            // There is no concept of a popup without an extension.
            // However, the event tis still triggered to start timers
            // and such that rely on the event.
            this.app.setState({ui: {visible: true}})
            for (let moduleName of Object.keys(this.app.plugins)) {
                if (this.app.plugins[moduleName]._onPopupAction) {
                    this.app.plugins[moduleName]._onPopupAction('open')
                }
            }
        }
    }


    /**
    * Restore stored dumped state from localStorage.
    * The menubar should be inactive without any overriding events.
    * @param {Object} moduleStore - Root property for this module.
    */
    _restoreState(moduleStore) {
        moduleStore.menubar = {
            base: 'inactive',
            event: null,
        }
    }


    /**
    * Deal with menubar icon changes made to the store in
    * an environment-specific way.
    * @returns {Object} The store properties to watch.
    */
    _watchers() {
        return {
            'store.ui.menubar.base': (menubarIcon) => {
                this.__menubarIcon(menubarIcon)
            },
            'store.ui.menubar.event': (eventName) => {
                if (this.app.env.isExtension) {
                    // Reset all animations.
                    this.__menubarAnimation()
                    if (eventName) {
                        if (eventName === 'ringing') {
                            this.__menubarAnimation('ringing')
                        } else if (eventName === 'calling') {
                            browser.browserAction.setIcon({path: 'img/menubar-ringing-4.png'})
                        } else {
                            browser.browserAction.setIcon({path: `img/menubar-${eventName}.png`})
                        }
                    } else {
                        browser.browserAction.setIcon({path: `img/menubar-${this.app.state.ui.menubar.base}.png`})
                    }
                }
            },
        }
    }


    /**
    * Restore the menubar to a valid state. This is for instance needed
    * when switching off a state like dnd or a selected queue.
    * @param {String} [base] -
    */
    menubarState(base = null) {
        const user = this.app.state.user
        const uaStatus = this.app.state.calls.ua.status

        if (base) {
            this.app.setState({ui: {menubar: {base}}})
            return
        }

        // Generic menubar behaviour.
        if (this.app.state.app.session.active && !user.authenticated) base = 'lock'
        else if (!user.authenticated) base = 'inactive'
        else if (uaStatus === 'disconnected') base = 'disconnected'
        else {
            if (this.app.state.settings.webrtc.enabled) {
                if (uaStatus === 'registered') {
                    if (this.app.state.availability.dnd) base = 'dnd'
                    else base = 'active'
                } else base = 'disconnected'
            } else {
                // ConnectAB only connects to a SIP backend.
                if (uaStatus === 'connected') {
                    base = 'active'
                } else base = 'disconnected'
            }
        }

        // Modules can override the generic menubar behaviour using
        // a custom `_menubarState` method.
        for (let moduleName of Object.keys(this.app.plugins)) {
            if (this.app.plugins[moduleName]._menubarState) {
                const moduleMenubarState = this.app.plugins[moduleName]._menubarState()
                if (moduleMenubarState) base = moduleMenubarState
            }
        }
        this.app.setState({ui: {menubar: {base}}})
    }


    /**
    * Create a system notification. The type used depends on the OS. Linux
    * uses inotify by default. Note that we can't use buttons here, because
    * that would require a service-worker implementation.
    * @param {Object} opts - Notification options.
    * @param {Boolean} opts.force - Force to show the notification.
    * @param {String} opts.message - Message body for the notification.
    * @param {String} [opts.number] - Number is used to target specific click-to-dial labels.
    * @param {String} opts.title - Title header for the notification.
    * @param {Boolean} [opts.stack] - Whether to stack the notifications.
    */
    notification({force = false, message, number = null, title, stack = false, timeout = 3000, call = null}) {
        if (this.app.env.isNode) return

        const options = {
            message: message,
            title: title,
            type: 'basic',
        }
        options.iconUrl = 'img/notification.png'

        if (this.app.env.isExtension) {
            // Notify click-to-dial icon labels.
            if (number) {
                if (title) {
                    // Used to restore click-to-dial icon label state
                    // when reloading a tab page.
                    this.lastLabelMessage = {enabled: false, label: title, numbers: [number]}
                    this.app.plugins.extension.tabs.signalIcons(this.lastLabelMessage)
                } else {
                    // No title is a reason to re-enable the target click-to-dial icon.
                    this.app.plugins.extension.tabs.signalIcons({enabled: true, label: null, numbers: [number]})
                    this.lastLabelMessage = null
                }
            }

            // Only create a notification under the right conditions.
            if (!message || !title || (this.app.state.ui.visible && !force)) return

            var notificationOptions = {
                type: 'basic',
                iconUrl: 'img/logo-128.png',
                title: title,
                message: message,
                requireInteraction: true,
            };

            if (call) {
                // notificationOptions.buttons = [
                //     {
                //         title: 'Accept call',
                //     },
                //     {
                //         title: 'Decline call',
                //     },
                // ];
            }

            // Let's check if the browser supports notifications
            if (!('Notification' in window)) {
                alert('This browser does not support desktop notification');
            }

            // Let's check whether notification permissions have already been granted
            else if (Notification.permission === 'granted') {
                // If it's okay let's create a notification
                browser.notifications.create('incoming_call', notificationOptions);
            }

            // Otherwise, we need to ask the user for permission
            else if (Notification.permission !== 'denied') {
                Notification.requestPermission().then(function (permission) {
                    // If the user accepts, let's create a notification
                    if (permission === 'granted') {
                        browser.notifications.create('incoming_call', notificationOptions);
                    }
                });
            }

            // browser.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
            //     if (notificationId == 'incoming_call') {
            //         switch (buttonIndex) {
            //             // Accept call
            //             case 0:
            //                 this.app.emit('bg:calls:call_accept', { callId: call.id })
            //                 break;
                    
            //             // Decline call
            //             case 1:
            //                 this.app.emit('bg:calls:call_terminate', { callId: call.id })
            //                 break;
            //         }
            //     }
            // })


            // options.iconUrl = browser.runtime.getURL(options.iconUrl)
            // if (!stack) browser.notifications.clear('c2d')
            // browser.notifications.create('c2d', options)
            // setTimeout(() => browser.notifications.clear('c2d'), timeout)
            // console.log(arguments);
            return
        }


        // Only create a notification under the right conditions.
        if (this.app.state.ui) {
            if (!message || !title || (this.app.state.ui.visible && !force)) return
        }

        options.icon = options.iconUrl
        options.body = message

        // Notification API may be disabled during tests or when running in Node.
        if (!('Notification' in global)) return

        if (Notification.permission === 'granted') {
            if (!stack && this._notification) this._notification.close()
            this._notification = new Notification(title, options) // eslint-disable-line no-new
            setTimeout(() => this._notification.close(), timeout)
        } else if (Notification.permission !== 'denied') {
            // Create a notification after the user
            // accepted the permission.
            Notification.requestPermission((permission) => {
                if (permission === 'granted') {
                    this._notification = new Notification(title, options) // eslint-disable-line no-new
                    setTimeout(() => this._notification.close(), timeout)
                }
            })
        }
    }

}

module.exports = PluginUI
