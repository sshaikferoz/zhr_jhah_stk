sap.ui.define([
    "sap/ui/core/Control"
], function (Control) {
    "use strict";

    /**
     * Wrapper that lays out its content in a responsive CSS grid
     * (css/style.css: .zhrSlotGrid). It exists because the object-page form's
     * ColumnLayout only accepts sap.ui.core.IFormContent as field content, which
     * the standard layout containers (VBox/HBox/FlexBox) do not implement.
     */
    return Control.extend("com.jhah.zhrjhahsecstk.ext.control.SlotGrid", {
        metadata: {
            interfaces: ["sap.ui.core.IFormContent"],
            defaultAggregation: "content",
            aggregations: {
                content: { type: "sap.ui.core.Control", multiple: true }
            }
        },

        renderer: {
            apiVersion: 2,
            render: function (oRm, oControl) {
                oRm.openStart("div", oControl).class("zhrSlotGrid").openEnd();
                oControl.getContent().forEach(function (oChild) {
                    oRm.renderControl(oChild);
                });
                oRm.close("div");
            }
        }
    });
});
