
import postRobot from 'post-robot/src';
import { SyncPromise as Promise } from 'sync-browser-mocks/src/promise';
import { BaseComponent } from '../base';
import { getParentComponentWindow, parseWindowName } from '../window';
import { noop, extend, getParentWindow, onCloseWindow } from '../../lib';
import { POST_MESSAGE, CONTEXT_TYPES } from '../../constants';
import { IntegrationError } from '../../error';
import { normalizeProps } from '../props';

/*  Child Component
    ---------------

    This is the portion of code which runs inside the frame or popup window containing the component's implementation.

    When the component author calls myComponent.attach(), it creates a new instance of ChildComponent, which is then
    responsible for managing the state and messaging back up to the parent, and providing props for the component to
    utilize.
*/

export class ChildComponent extends BaseComponent {

    constructor(component, options = {}) {
        super(component, options);
        this.component = component;

        this.component.log(`construct_child`);

        this.validate(options);

        // Handlers for various component lifecycle events

        this.onEnter = this.tryCatch(options.onEnter || noop);
        this.onClose = this.tryCatch(options.onClose || noop);
        this.onProps = this.tryCatch(options.onProps || noop, false);
        this.onError = this.tryCatch(options.onError || (err => { throw err; }));

        // The child can specify some default props if none are passed from the parent. This often makes integrations
        // a little more seamless, as applicaiton code can call props.foo() without worrying about whether the parent
        // has provided them or not, and fall-back to some default behavior.

        this.props = normalizeProps(this.component, this, options.defaultProps || {});

        // We support a 'standalone' mode where the child isn't actually created by xcomponent. This may be because
        // there's an existing full-page implementation which uses redirects. In this case, the user can specify
        // standalone: true, and defaultProps, and the child component should continue to function in the same way
        // as if it were created by xcomponent, with the exception that no post-messages will ever be sent.

        this.standalone = options.standalone;
    }

    /*  Init
        ----

        Message up to the parent to let them know we've rendered successfully, and get some initial data and props
    */

    init() {

        this.component.log(`init_child`);

        // In standalone mode, we would expect setWindows to fail since there is no parent window and window.name
        // will not be generated by xcomponent. In this case we can fail silently, whereas normally we'd want to
        // fail hard here.

        try {
            this.setWindows();
        } catch (err) {

            if (this.standalone) {
                this.component.log(`child_standalone`);
                return;
            }

            throw err;
        }

        // In standalone mode, there's no point messaging back up to our parent -- because we have none. :'(

        if (this.standalone && !getParentComponentWindow()) {
            return Promise.resolve();
        }

        // Start listening for post messages

        this.listen(getParentComponentWindow());
        if (getParentWindow() !== getParentComponentWindow()) {
            this.listen(getParentWindow());
        }

        // Send an init message to our parent. This gives us an initial set of data to use that we can use to function.
        //
        // For example:
        //
        // - What context are we
        // - What props has the parent specified

        return this.sendToParentComponent(POST_MESSAGE.INIT).then(data => {

            this.context = data.context;
            extend(this.props, data.props);

            this.onEnter.call(this);
            this.onProps.call(this);

        }).catch(err => this.onError(err));
    }


    /*  Send to Parent
        --------------

        Send a post message to our parent window.
    */

    sendToParent(name, data) {
        this.component.log(`send_to_parent_${name}`);
        return postRobot.send(getParentWindow(), name, data);
    }


    /*  Send to Parent Component
        ------------------------

        Send a post message to our parent component window. Note -- this may not be our immediate parent, if we were
        rendered using renderToParent.
    */

    sendToParentComponent(name, data) {
        this.component.log(`send_to_parent_component_${name}`);
        return postRobot.send(getParentComponentWindow(), name, data);
    }


    /*  Set Windows
        -----------

        Determine the parent window, and the parent component window. Note -- these may be different, if we were
        rendered using renderToParent.
    */

    setWindows() {


        // Ensure we do not try to .attach() multiple times for the same component on the same page

        if (window.__activeXComponent__) {
            throw new Error(`[${this.component.tag}] Can not attach multiple components to the same window`);
        }

        window.__activeXComponent__ = this;

        // Get the direct parent window

        if (!getParentWindow()) {
            throw new Error(`[${this.component.tag}] Can not find parent window`);
        }

        if (!getParentComponentWindow()) {
            throw new Error(`[${this.component.tag}] Can not find parent component window`);
        }

        let winProps = parseWindowName(window.name);

        this.component.log(`child_win_props`, winProps);

        if (winProps.tag !== this.component.tag) {
            throw new Error(`[${this.component.tag}] Parent is ${winProps.tag} - can not attach ${this.component.tag}`);
        }

        // Note -- getting references to other windows is probably one of the hardest things to do. There's basically
        // only a few ways of doing it:
        //
        // - The window is a direct parent, in which case you can use window.parent or window.opener
        // - The window is an iframe owned by you or one of your parents, in which case you can use window.frames
        // - The window sent you a post-message, in which case you can use event.source
        //
        // If we didn't rely on winProps.parent here from the window name, we'd have to relay all of our messages through
        // our actual parent. Which is no fun at all, and pretty error prone even with the help of post-robot. So this
        // is the lesser of two evils until browsers give us something like getWindowByName(...)

        // If the parent window closes, we need to close ourselves. There's no point continuing to run our component
        // if there's no parent to message to.

        this.watchForClose();
    }


    /*  Watch For Close
        ---------------

        Watch both the parent window and the parent component window, if they close, close this window too.
    */

    watchForClose() {

        onCloseWindow(getParentWindow, () => {

            this.component.log(`parent_window_closed`);

            this.onClose(new Error(`[${this.component.tag}] parent window was closed`));

            // We only need to close ourselves if we're a popup -- otherwise our parent window closing will automatically
            // close us, if we're an iframe

            if (this.context === CONTEXT_TYPES.POPUP) {
                window.close();
            }
        });

        // Only listen for parent component window if it's actually a different window

        if (getParentComponentWindow() && getParentComponentWindow() !== getParentWindow()) {
            onCloseWindow(getParentComponentWindow, () => {

                this.component.log(`parent_component_window_closed`);

                // We do actually need to close ourselves in this case, even if we're an iframe, because our component
                // window is probably a sibling and we'll remain open by default.

                this.close(new Error(`[${this.component.tag}] parent component window was closed`));
            });
        }
    }


    /*  Validate
        --------

        Validate any options passed in to ChildComponent
    */

    validate(options) {

        // TODO: Implement this
    }


    /*  Listeners
        ---------

        Post-message listeners that will be automatically set up to listen for messages from the parent component
    */

    listeners() {
        return {

            // New props are being passed down

            [ POST_MESSAGE.PROPS ](source, data) {
                extend(this.props, data.props);
                this.onProps.call(this);
            },

            // The parent wants us to close.

            [ POST_MESSAGE.CLOSE ](source, data) {

                // Our parent is telling us we're going to close

                if (source === getParentWindow()) {
                    this.onClose.call(this);
                }

                // Our component parent is asking us to close

                else {
                    this.sendToParent(POST_MESSAGE.CLOSE).catch(err => this.onError(err));
                }
            }
        };
    }


    /*  Resize
        ------

        Resize the child window. Must be done on a user action like a click if we're in a popup
    */

    resize(width, height) {
        return Promise.resolve().then(() => {

            this.component.log(`resize`, { width, height });

            if (this.context === CONTEXT_TYPES.POPUP) {
                return window.resizeTo(width, height);
            }

            return this.sendToParent(POST_MESSAGE.RESIZE, { width, height });
        });
    }


    /*  Close
        -----

        Close the child window
    */

    close(err) {

        this.component.log(`close_child`);

        this.onClose.call(this, err);

        // Ask our parent window to close us

        return this.sendToParent(POST_MESSAGE.CLOSE);
    }


    /*  Focus
        -----

        Focus the child window. Must be done on a user action like a click
    */

    focus() {
        this.component.log(`focus`);

        window.focus();
    }


    /*  Error
        -----

        Send an error back to the parent
    */

    error(err) {

        this.component.log(`error`, { error: err.stack || err.toString() });

        if (!(err instanceof IntegrationError)) {
            console.error(err.stack);
            err = new Error(`[${this.component.tag}] Child lifecycle method threw an error`);
        }

        return this.sendToParentComponent(POST_MESSAGE.ERROR, {
            error: err.stack ? `${err.message}\n${err.stack}` : err.toString()
        });
    }
}
